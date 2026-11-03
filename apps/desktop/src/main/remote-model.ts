import type { CompletionRequest, NetworkEntry, OperatorModel } from '@companyos/twin-core';

/**
 * The task operator's model on Chutes, used only when the person picks it. A request carries the task's goal, the front
 * app's control names and the steps so far. The text inside fields and memory notes go only when the person ticked the box
 * for that task. Every call is written to the ledger with the host, the path, the bytes sent and whether it carried
 * screen text, never the content. Redirects are refused, so the request cannot be carried to another host.
 */
const CHUTES_ENDPOINT = 'https://llm.chutes.ai/v1/chat/completions';
const CHUTES_MODEL = 'Qwen/Qwen3.5-397B-A17B-TEE';
const KEY_SHAPE = /^cpk_[A-Za-z0-9._-]{10,200}$/;
const CALL_TIMEOUT_MS = 120_000;

export function validChutesKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

interface ChutesChatOptions {
  apiKey: string;
  model?: string;
  /** Whether this task sends text from the screen or memory notes. The ledger shows it on every call. */
  sharesScreenText: boolean;
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * What a failed status means, in words the person can act on. Each is a fixed sentence with the status number, so no part
 * of the response body or the key reaches the page.
 */
export function chutesFailure(status: number): string {
  if (status === 401 || status === 403) return `Chutes refused the key (${status}). Remove the key on the Tasks page and save one that works.`;
  if (status === 402) return 'Chutes says the account has no balance or quota left (402). Top it up on chutes.ai, then try again.';
  if (status === 404) return 'Chutes does not offer this model at the moment (404).';
  if (status === 429) return 'Chutes is limiting calls for this key (429). Wait a minute, then try again.';
  if (status >= 500) return `Chutes had a problem on its side (${status}). Try again in a minute.`;
  return `Chutes returned ${status}.`;
}

/** Removes a reasoning block and a code fence, which some models add around the JSON. */
function unwrap(content: string): string {
  const trimmed = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
  return fenced ? fenced[1] : trimmed;
}

export function createChutesChat(options: ChutesChatOptions): OperatorModel {
  if (!validChutesKey(options.apiKey)) throw new Error('The Chutes key is not in the cpk_ format.');
  const url = new URL(CHUTES_ENDPOINT);
  const model = options.model ?? CHUTES_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  return {
    async complete(request: CompletionRequest): Promise<unknown> {
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
        throw new Error(chutesFailure(response.status));
      }
      try {
        const reply = (await response.json()) as { choices?: { message?: { content?: unknown } }[] };
        const content = reply.choices?.[0]?.message?.content;
        const parsed: unknown = JSON.parse(unwrap(typeof content === 'string' ? content : ''));
        log('ok');
        return parsed;
      } catch {
        log('failed');
        throw new Error('Chutes gave an answer that is not JSON.');
      }
    },
  };
}
