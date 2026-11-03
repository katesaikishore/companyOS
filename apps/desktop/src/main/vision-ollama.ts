import type { CompletionRequest, NetworkEntry, OperatorModel, TextEmbedder, VisionCompleter, VisionRequest } from '@companyos/twin-core';

/**
 * The local vision model, served by Ollama on this Mac. The address must be the loopback address: the app refuses any other
 * host, so a screenshot never leaves the device. Every call is written to the ledger with where it went and how many bytes
 * of picture it sent, never the picture or the reply.
 */
const OLLAMA_BASE = 'http://127.0.0.1:11434';
export const VISION_MODEL = 'qwen3-vl:2b-instruct';
/**
 * The model that plans the operator's steps from an app's controls: Qwen3 4B Instruct at Q4, 2.5 GB, text only. The 2B
 * vision model understands screen text well but could not plan steps: on a real TextEdit window it pressed Close instead of
 * typing. The 4B model typed the right line at once.
 */
export const PLANNER_MODEL = 'qwen3:4b-instruct-2507-q4_K_M';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
const CALL_TIMEOUT_MS = 120_000;
const CHECK_TIMEOUT_MS = 2_000;

/** The address as a URL, or an error when it is not plain http to this Mac. */
export function loopbackUrl(base: string): URL {
  const url = new URL(base);
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTS.has(url.hostname)) throw new Error('The local vision model must run on this Mac.');
  return url;
}

interface OllamaVisionOptions {
  baseUrl?: string;
  model?: string;
  /** How long Ollama keeps the model in memory after a call, such as '5m' or 0 to free it at once. Ollama's default when unset. */
  keepAlive?: string | number;
  fetchImpl?: typeof fetch;
  record: (entry: NetworkEntry) => void;
  now?: () => number;
}

/** A vision completer that asks the Ollama server on this Mac. Hidden reasoning is switched off, so the budget goes to the answer. */
export function createOllamaVision(options: OllamaVisionOptions): VisionCompleter {
  const base = loopbackUrl(options.baseUrl ?? OLLAMA_BASE);
  const model = options.model ?? VISION_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const url = new URL('/api/chat', base);

  return {
    async describe(request: VisionRequest): Promise<unknown> {
      const ts = now();
      const log = (outcome: NetworkEntry['outcome']): void =>
        options.record({ ts, purpose: 'local_model', host: url.hostname, path: url.pathname, bytes: request.imagePng.byteLength, outcome });

      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          // A redirect could carry the picture to another host, so it is refused.
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            model,
            stream: false,
            think: false,
            format: request.schema,
            options: { temperature: 0, num_predict: request.maxTokens },
            messages: [
              { role: 'system', content: request.system },
              { role: 'user', content: request.prompt, images: [Buffer.from(request.imagePng).toString('base64')] },
            ],
          }),
          signal: AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        });
      } catch {
        log('failed');
        throw new Error('The local vision model did not answer.');
      }
      if (!response.ok) {
        log('failed');
        throw new Error(`The local vision model returned ${response.status}.`);
      }

      let body: unknown;
      try {
        body = await response.json();
      } catch {
        log('failed');
        throw new Error('The local vision model returned a body that is not JSON.');
      }
      const content = (body as { message?: { content?: unknown } }).message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        log('failed');
        throw new Error('The local vision model gave no answer.');
      }
      try {
        const parsed: unknown = JSON.parse(content);
        log('ok');
        return parsed;
      } catch {
        log('failed');
        throw new Error('The local vision model gave an answer that is not JSON.');
      }
    },
  };
}

type VisionModelState = 'ready' | 'server_down' | 'model_missing';

/**
 * Whether the server on this Mac is up and the vision model is pulled. It is a GET for the model list, with no picture, and
 * it is written to the ledger like every other call.
 */
export async function visionModelReady(
  options: { baseUrl?: string; model?: string; fetchImpl?: typeof fetch; record?: (entry: NetworkEntry) => void; now?: () => number } = {},
): Promise<VisionModelState> {
  const url = new URL('/api/tags', loopbackUrl(options.baseUrl ?? OLLAMA_BASE));
  const model = options.model ?? VISION_MODEL;
  const ts = (options.now ?? Date.now)();
  const log = (outcome: NetworkEntry['outcome']): void =>
    options.record?.({ ts, purpose: 'local_model', host: url.hostname, path: url.pathname, bytes: 0, outcome });
  let body: unknown;
  try {
    const response = await (options.fetchImpl ?? fetch)(url, { redirect: 'error', signal: AbortSignal.timeout(CHECK_TIMEOUT_MS) });
    if (!response.ok) {
      log('failed');
      return 'server_down';
    }
    body = await response.json();
  } catch {
    log('failed');
    return 'server_down';
  }
  log('ok');
  const names = ((body as { models?: { name?: unknown }[] }).models ?? []).map(entry => entry.name);
  return names.includes(model) ? 'ready' : 'model_missing';
}

/** The embedding model for understanding screen text: all-MiniLM-L6, 46 MB, 384 numbers per text. */
export const EMBED_MODEL = 'all-minilm';

/**
 * A text embedder on the Ollama server on this Mac. The text goes to the loopback address only, and each call is written to
 * the ledger with its size, never the text.
 */
export function createOllamaEmbedder(options: OllamaVisionOptions): TextEmbedder {
  const base = loopbackUrl(options.baseUrl ?? OLLAMA_BASE);
  const model = options.model ?? EMBED_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const url = new URL('/api/embed', base);
  return {
    async embed(texts, signal) {
      const ts = now();
      const body = JSON.stringify({ model, input: texts });
      const log = (outcome: NetworkEntry['outcome'], status?: number): void =>
        options.record({ ts, purpose: 'local_model', host: url.hostname, path: url.pathname, bytes: Buffer.byteLength(body), outcome, ...(status === undefined ? {} : { status }) });
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        });
      } catch {
        log(signal?.aborted ? 'cancelled' : 'failed');
        throw new Error('Ollama is not running on this Mac. Open Ollama, then try again.');
      }
      if (!response.ok) {
        log('failed', response.status);
        if (response.status === 404) throw new Error(`The embedding model ${model} is not installed in Ollama. Run: ollama pull ${model}`);
        throw new Error(`The embedding model returned ${response.status}.`);
      }
      const reply = (await response.json().catch(() => ({}))) as { embeddings?: unknown };
      const vectors = reply.embeddings;
      if (!Array.isArray(vectors) || vectors.length !== texts.length || !vectors.every(row => Array.isArray(row) && row.every(n => typeof n === 'number'))) {
        log('failed');
        throw new Error('The embedding model gave an answer that is not a list of vectors.');
      }
      log('ok');
      return vectors as number[][];
    },
  };
}

/**
 * A text model on the Ollama server on this Mac: the step planner by default, or the vision model when it is passed in to
 * understand screen text. Hidden reasoning is off. Nothing leaves the device.
 */
export function createOllamaChat(options: OllamaVisionOptions): OperatorModel {
  const base = loopbackUrl(options.baseUrl ?? OLLAMA_BASE);
  const model = options.model ?? PLANNER_MODEL;
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now;
  const url = new URL('/api/chat', base);
  return {
    async complete(request: CompletionRequest): Promise<unknown> {
      const ts = now();
      const body = JSON.stringify({
        model,
        stream: false,
        think: false,
        format: request.schema,
        options: { temperature: 0, num_predict: request.maxTokens },
        ...(options.keepAlive === undefined ? {} : { keep_alive: options.keepAlive }),
        messages: [
          { role: 'system', content: request.system },
          { role: 'user', content: request.prompt },
        ],
      });
      const log = (outcome: NetworkEntry['outcome'], status?: number): void =>
        options.record({ ts, purpose: 'local_model', host: url.hostname, path: url.pathname, bytes: Buffer.byteLength(body), outcome, ...(status === undefined ? {} : { status }) });
      let response: Response;
      try {
        response = await fetchImpl(url, {
          method: 'POST',
          redirect: 'error',
          headers: { 'content-type': 'application/json' },
          body,
          signal: AbortSignal.any([...(request.signal ? [request.signal] : []), AbortSignal.timeout(CALL_TIMEOUT_MS)]),
        });
      } catch (error) {
        log(request.signal?.aborted ? 'cancelled' : 'failed');
        if (error instanceof Error && error.name === 'TimeoutError') throw new Error('The local model did not answer in time. Try again, or pick Chutes for this task.');
        throw new Error('Ollama is not running on this Mac. Open Ollama, then try again.');
      }
      if (!response.ok) {
        log('failed', response.status);
        if (response.status === 404) throw new Error(`The model ${model} is not installed in Ollama (404).`);
        throw new Error(`The local model returned ${response.status}.`);
      }
      try {
        const reply = (await response.json()) as { message?: { content?: unknown } };
        const parsed: unknown = JSON.parse(typeof reply.message?.content === 'string' ? reply.message.content : '');
        log('ok');
        return parsed;
      } catch {
        log('failed');
        throw new Error('The local model gave an answer that is not JSON.');
      }
    },
  };
}
