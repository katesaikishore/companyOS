import type { CompletionRequest, NetworkEntry, OperatorModel } from '@companyos/twin-core';

/**
 * The task operator's model on Chutes, used only when the person picks it. A request carries the task's goal, the front
 * app's control names and the steps so far. The text inside fields and memory notes go only when the person ticked the box
 * for that task. Every call is written to the ledger with the host, the path, the bytes sent and whether it carried
 * screen text, never the content. Redirects are refused, so the request cannot be carried to another host.
 */
const CHUTES_ENDPOINT = 'https://llm.chutes.ai/v1/chat/completions';
/**
 * The models tried in turn, all run in trusted execution environments. Each model on Chutes runs on its own pool of
 * machines, so when one answers busy (429, 503) or is not offered (404), the next one usually has room.
 */
const CHUTES_MODELS = ['Qwen/Qwen3.5-397B-A17B-TEE', 'deepseek-ai/DeepSeek-V3.2-TEE', 'moonshotai/Kimi-K2.6-TEE'];
/** Answers that mean this model is busy right now: worth a short wait and one more try before the next model. */
const BUSY = new Set([429, 503]);
/** Answers after which the next model is tried. */
const NEXT_MODEL = new Set([404, 429, 503]);
const TRIES_PER_MODEL = 2;
const FIRST_WAIT_MS = 1_500;
/** The longest wait for one retry, whatever Retry-After asks. */
const MAX_WAIT_MS = 8_000;
const KEY_SHAPE = /^cpk_[A-Za-z0-9._-]{10,200}$/;
const CALL_TIMEOUT_MS = 120_000;

export function validChutesKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

interface ChutesChatOptions {
  apiKey: string;
  /** The first model to ask, then the fallbacks. */
  model?: string;
  fallbackModels?: readonly string[];
  /** Whether this task sends text from the screen or memory notes. The ledger shows it on every call. */
  sharesScreenText: boolean;
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Waits between retries. Tests pass one that does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

/** What a busy answer's body says, sorted into a few kinds. The body itself never leaves this file. */
export type BusyKind = 'capacity' | 'limit';

export function busyKind(body: string): BusyKind | undefined {
  if (/capacity|no instances|unavailable|overloaded|busy|try again later/i.test(body)) return 'capacity';
  if (/rate.?limit|too many requests|quota|limit exceeded/i.test(body)) return 'limit';
  return undefined;
}

/**
 * What a failed status means, in words the person can act on. Each is a fixed sentence with the status number, so no part
 * of the response body or the key reaches the page; a busy answer is told apart only by its kind.
 */
export function chutesFailure(status: number, kind?: BusyKind): string {
  if (status === 401 || status === 403) return `Chutes refused the key (${status}). Remove the key on the Tasks page and save one that works.`;
  if (status === 402) return 'Chutes says the account has no balance or quota left (402). Top it up on chutes.ai, then try again.';
  if (status === 404) return 'Chutes does not offer these models at the moment (404).';
  if (status === 429 && kind === 'capacity') return 'Chutes says its models are at capacity (429). Every model was tried; try again in a minute.';
  if (status === 429 && kind === 'limit') return 'Chutes is limiting calls for this key (429). Wait a minute, then try again.';
  if (status === 429) return 'Chutes answered busy (429) for every model it was asked. Wait a minute, then try again.';
  if (status >= 500) return `Chutes had a problem on its side (${status}). Try again in a minute.`;
  return `Chutes returned ${status}.`;
}

/** Removes a reasoning block and a code fence, which some models add around the JSON. */
function unwrap(content: string): string {
  const trimmed = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

/** A Retry-After in seconds, as a wait in milliseconds; undefined for none or a date. */
function retryAfterMs(response: Response): number | undefined {
  const value = Number(response.headers.get('retry-after'));
  return Number.isFinite(value) && value > 0 ? value * 1_000 : undefined;
}

function pause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error('The task was stopped.'));
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => (clearTimeout(timer), reject(new Error('The task was stopped.'))), { once: true });
  });
}

export function createChutesChat(options: ChutesChatOptions): OperatorModel {
  if (!validChutesKey(options.apiKey)) throw new Error('The Chutes key is not in the cpk_ format.');
  const url = new URL(CHUTES_ENDPOINT);
  const models = [options.model ?? CHUTES_MODELS[0], ...(options.fallbackModels ?? (options.model ? [] : CHUTES_MODELS.slice(1)))];
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;

  /** One call to one model: the parsed reply, or the status and kind of a failed answer. */
  const ask = async (model: string, request: CompletionRequest): Promise<{ reply: unknown } | { status: number; kind?: BusyKind; waitMs?: number }> => {
      const ts = now();
      const body = JSON.stringify({
        model,
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
        max_tokens: request.maxTokens,
        temperature: 0,
        // Hidden reasoning would spend the whole budget before the answer.
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'reply', schema: request.schema } },
      });
      const log = (outcome: NetworkEntry['outcome'], status?: number): void =>
        options.record({
          ts,
          purpose: 'remote_model',
          host: url.hostname,
          path: url.pathname,
          bytes: Buffer.byteLength(body),
          outcome,
          sharedScreenText: options.sharesScreenText,
          ...(status === undefined ? {} : { status }),
        });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
          body,
          signal: AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        });
      } catch (error) {
        // A Stop is not a failure of Chutes, so it is not reported as one.
        log(request.signal?.aborted ? 'cancelled' : 'failed');
        if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Chutes did not answer within 2 minutes. Try again.');
        throw new Error('Chutes could not be reached. Check the internet connection.');
      }
      if (!response.ok) {
        log('failed', response.status);
        // The body is read only to sort a busy answer; it is never kept or shown.
        const kind = BUSY.has(response.status) ? busyKind(await response.text().catch(() => '')) : undefined;
        return { status: response.status, ...(kind ? { kind } : {}), ...(retryAfterMs(response) ? { waitMs: retryAfterMs(response) } : {}) };
      }
      try {
        const reply = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
        const content = reply.choices?.[0]?.message?.content;
        const parsed: unknown = JSON.parse(unwrap(typeof content === 'string' ? content : ''));
        log('ok');
        return { reply: parsed };
      } catch {
        log('failed');
        throw new Error('Chutes gave an answer that is not JSON.');
      }
  };

  return {
    /**
     * Asks the models in turn. A busy model gets a short wait, as long as Retry-After asks up to a limit, and one more
     * try; a model that stays busy or is not offered hands over to the next. Any other failure ends the call at once.
     */
    async complete(request: CompletionRequest): Promise<unknown> {
      let last: { status: number; kind?: BusyKind } | undefined;
      for (const model of models) {
        for (let attempt = 0; attempt < TRIES_PER_MODEL; attempt += 1) {
          const answer = await ask(model, request);
          if ('reply' in answer) return answer.reply;
          last = { status: answer.status, ...(answer.kind ? { kind: answer.kind } : {}) };
          if (!NEXT_MODEL.has(answer.status)) throw new Error(chutesFailure(answer.status, answer.kind));
          if (!BUSY.has(answer.status) || attempt + 1 === TRIES_PER_MODEL) break;
          await sleep(Math.min(answer.waitMs ?? FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS), request.signal);
        }
      }
      throw new Error(chutesFailure(last?.status ?? 429, last?.kind));
    },
  };
}
