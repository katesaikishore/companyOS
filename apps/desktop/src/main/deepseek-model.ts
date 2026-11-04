import type { CompletionRequest, NetworkEntry, OperatorModel } from '@companyos/twin-core';
import { pause, retryAfterMs, unwrap } from './remote-model';

/**
 * The task operator's model on DeepSeek, used when the person picks it: DeepSeek V4.1 Flash through DeepSeek's Responses
 * API, with thinking off, as one step is one small decision. The Responses API holds the reply to the turn's JSON schema,
 * as Chutes does, so the model cannot name a control that is not on the screen; it is stateless, so DeepSeek keeps
 * nothing between calls. A request carries the task's goal, the front app's control names
 * and the steps so far; the text inside fields and memory notes go only when the person ticked the box for that task.
 * Every call is written to the ledger with the host, the path, the bytes sent and whether it carried screen text, never
 * the content. Redirects are refused, so the request cannot be carried to another host.
 */
const DEEPSEEK_ENDPOINT = 'https://api.deepseek.com/responses';
const DEEPSEEK_MODEL = 'deepseek-flash';
/** sk- and letters and digits only, so an Anthropic key (sk-ant-…) is not taken for one. */
const KEY_SHAPE = /^sk-[A-Za-z0-9]{20,100}$/;
/** DeepSeek keeps a request open while it is busy rather than refusing it, so it gets longer than Chutes. */
export const DEEPSEEK_TIMEOUT_MS = 60_000;
const TRIES = 2;
const FIRST_WAIT_MS = 1_500;
const MAX_WAIT_MS = 8_000;
/** Answers worth one more try after a short wait. */
const RETRY = new Set([429, 500, 502, 503]);

export function validDeepSeekKey(key: string): boolean {
  return KEY_SHAPE.test(key);
}

/** What a failed call means, in words the person can act on. Fixed sentences: no part of the body or the key reaches the page. */
export function deepseekFailure(status: number): string {
  if (status === 401 || status === 403) return `DeepSeek refused the key (${status}). Remove the key on the Tasks page and save one that works.`;
  if (status === 402) return 'DeepSeek says the account has no balance left (402). Top it up on platform.deepseek.com, then try again.';
  if (status === 400 || status === 422) return `DeepSeek could not take the request (${status}).`;
  if (status === 429) return 'DeepSeek is limiting calls for this key (429). Wait a minute, then try again.';
  if (status >= 500) return `DeepSeek had a problem on its side (${status}). Try again in a minute.`;
  return `DeepSeek returned ${status}.`;
}

interface DeepSeekChatOptions {
  apiKey: string;
  model?: string;
  /** Whether this task sends text from the screen or memory notes. The ledger shows it on every call. */
  sharesScreenText: boolean;
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Waits between tries. Tests pass one that does not wait. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** How long one call gets. Tests pass a short one. */
  callTimeoutMs?: number;
}

/** The parts of a Responses API reply that are read. */
interface ResponsesReply {
  status?: string;
  incomplete_details?: { reason?: string } | null;
  output?: { type?: string; content?: { type?: string; text?: unknown }[] }[];
}

/** The reply's text: the output_text parts of its message items, joined. */
function outputText(reply: ResponsesReply): string {
  return (reply.output ?? [])
    .filter(item => item.type === 'message')
    .flatMap(item => item.content ?? [])
    .filter(part => part.type === 'output_text' && typeof part.text === 'string')
    .map(part => part.text as string)
    .join('');
}

export function createDeepSeekChat(options: DeepSeekChatOptions): OperatorModel {
  if (!validDeepSeekKey(options.apiKey)) throw new Error('The DeepSeek key is not in the sk- format.');
  const url = new URL(DEEPSEEK_ENDPOINT);
  const model = options.model ?? DEEPSEEK_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? pause;
  const callTimeoutMs = options.callTimeoutMs ?? DEEPSEEK_TIMEOUT_MS;

  const ask = async (request: CompletionRequest): Promise<{ reply: unknown } | { status: number; waitMs?: number }> => {
    const ts = now();
    const body = JSON.stringify({
      model,
      instructions: request.system,
      input: request.prompt,
      text: { format: { type: 'json_schema', name: 'reply', schema: request.schema } },
      reasoning: { effort: 'none' },
      max_output_tokens: request.maxTokens,
      temperature: 0,
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
    const deadline = AbortSignal.timeout(callTimeoutMs);
    try {
      response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json' },
        body,
        signal: AbortSignal.any([...(request.signal ? [request.signal] : []), deadline]),
      });
    } catch {
      // A Stop, or the caller's own time limit, is not a failure of DeepSeek: it is passed on as it is.
      if (request.signal?.aborted) {
        log('cancelled');
        throw request.signal.reason instanceof Error ? request.signal.reason : new Error('The task was stopped.');
      }
      log('failed');
      if (deadline.aborted) throw new Error(`DeepSeek did not answer within ${callTimeoutMs / 1000} seconds. Try again in a minute.`);
      throw new Error('DeepSeek could not be reached. Check the internet connection.');
    }
    if (!response.ok) {
      log('failed', response.status);
      // The body is never read: a failure is told by its status alone.
      await response.body?.cancel().catch(() => undefined);
      const waitMs = retryAfterMs(response);
      return { status: response.status, ...(waitMs ? { waitMs } : {}) };
    }
    let reply: ResponsesReply;
    try {
      reply = (await response.json()) as ResponsesReply;
    } catch {
      log('failed');
      throw new Error('DeepSeek gave an answer that is not JSON.');
    }
    if (reply.status === 'incomplete') {
      log('failed');
      throw new Error(reply.incomplete_details?.reason === 'content_filter' ? 'DeepSeek declined this step.' : 'DeepSeek ran out of room before it answered.');
    }
    try {
      const parsed: unknown = JSON.parse(unwrap(outputText(reply)));
      log('ok');
      return { reply: parsed };
    } catch {
      log('failed');
      throw new Error('DeepSeek gave an answer that is not JSON.');
    }
  };

  return {
    /** Asks DeepSeek. A busy or failing server gets a short wait, as long as Retry-After asks up to a limit, and one more try. */
    async complete(request: CompletionRequest): Promise<unknown> {
      let status = 0;
      for (let attempt = 0; attempt < TRIES; attempt += 1) {
        const answer = await ask(request);
        if ('reply' in answer) return answer.reply;
        status = answer.status;
        if (!RETRY.has(status) || attempt + 1 === TRIES) break;
        await sleep(Math.min(answer.waitMs ?? FIRST_WAIT_MS * 2 ** attempt, MAX_WAIT_MS), request.signal);
      }
      throw new Error(deepseekFailure(status));
    },
  };
}
