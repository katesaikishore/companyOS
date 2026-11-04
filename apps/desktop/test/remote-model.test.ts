import { describe, expect, it } from 'vitest';
import type { CompletionRequest, NetworkEntry } from '@companyos/twin-core';
import { busyKind, chutesFailure, createChutesChat, validChutesKey } from '../src/main/remote-model';
import { createOllamaChat } from '../src/main/vision-ollama';

const KEY = 'cpk_test_0123456789abcdef';
const REQUEST: CompletionRequest = { system: 'system text', prompt: 'goal and controls', schema: { type: 'object' }, maxTokens: 600 };

function fakeFetch(status: number, body: unknown, seen: { url: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('createChutesChat', () => {
  it('sends to llm.chutes.ai with reasoning off and redirects refused, and returns the parsed reply', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const records: NetworkEntry[] = [];
    const model = createChutesChat({ apiKey: KEY, sharesScreenText: true, record: entry => records.push(entry), fetchImpl: fakeFetch(200, { choices: [{ message: { content: '```json\n{"action":"done"}\n```' } }] }, seen), now: () => 7 });
    expect(await model.complete(REQUEST)).toEqual({ action: 'done' });
    expect(seen[0].url).toBe('https://llm.chutes.ai/v1/chat/completions');
    expect(seen[0].init?.redirect).toBe('error');
    expect(JSON.parse(String(seen[0].init?.body)).chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(records).toEqual([{ ts: 7, purpose: 'remote_model', host: 'llm.chutes.ai', path: '/v1/chat/completions', bytes: Buffer.byteLength(String(seen[0].init?.body)), outcome: 'ok', sharedScreenText: true }]);
  });

  it('records a failure with its status but without the body or the key, and refuses a key that is not one', async () => {
    const records: NetworkEntry[] = [];
    const model = createChutesChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: fakeFetch(402, 'balance detail') });
    const error = await model.complete(REQUEST).catch((thrown: Error) => thrown);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe(chutesFailure(402));
    expect((error as Error).message).not.toContain('balance detail');
    expect(records[0]).toMatchObject({ outcome: 'failed', status: 402 });
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain('balance detail');
    expect(() => createChutesChat({ apiKey: 'sk-not-chutes', sharesScreenText: false, record: () => undefined })).toThrow('cpk_');
    expect(validChutesKey('cpk_short')).toBe(false);
  });

  it('tells the person what a refused key, an empty account, a limit and a server fault each mean', () => {
    expect(chutesFailure(401)).toContain('refused the key');
    expect(chutesFailure(403)).toContain('refused the key');
    expect(chutesFailure(402)).toContain('no balance');
    expect(chutesFailure(429)).toContain('Wait a minute');
    expect(chutesFailure(503)).toContain('on its side (503)');
    expect(chutesFailure(418)).toBe('Chutes returned 418.');
  });

  it('says when Chutes cannot be reached, and logs a Stop as cancelled rather than failed', async () => {
    const records: NetworkEntry[] = [];
    const offline = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    const model = createChutesChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: offline });
    await expect(model.complete(REQUEST)).rejects.toThrow('could not be reached');
    const controller = new AbortController();
    controller.abort();
    await expect(model.complete({ ...REQUEST, signal: controller.signal })).rejects.toThrow();
    expect(records.map(entry => entry.outcome)).toEqual(['failed', 'cancelled']);
    expect(records[0]).not.toHaveProperty('status');
  });
});

describe('createChutesChat when a model is busy', () => {
  /** Answers each call in turn from a list of [status, body, retry-after], recording which model each call asked. */
  function sequence(answers: Array<[number, unknown, string?]>) {
    const models: string[] = [];
    let i = 0;
    const impl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      models.push(JSON.parse(String(init?.body)).model);
      const [status, body, retryAfter] = answers[Math.min(i++, answers.length - 1)];
      return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
    }) as typeof fetch;
    return { models, impl };
  }
  const ok: [number, unknown] = [200, { choices: [{ message: { content: '{"action":"done"}' } }] }];
  const atCapacity: [number, unknown] = [429, { detail: 'Infrastructure is at maximum capacity, try again later' }];

  it('waits as Chutes asks, tries again, then asks the next model, and returns its reply', async () => {
    const waits: number[] = [];
    const { models, impl } = sequence([[429, { detail: 'Infrastructure is at maximum capacity' }, '3'], atCapacity, ok]);
    const model = createChutesChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: impl, sleep: async ms => void waits.push(ms) });
    expect(await model.complete(REQUEST)).toEqual({ action: 'done' });
    expect(models).toEqual(['Qwen/Qwen3.5-397B-A17B-TEE', 'Qwen/Qwen3.5-397B-A17B-TEE', 'deepseek-ai/DeepSeek-V3.2-TEE']);
    expect(waits).toEqual([3000]);
  });

  it('says every model was at capacity in its own words, never in the answer’s, after trying each twice', async () => {
    const records: NetworkEntry[] = [];
    const { models, impl } = sequence([atCapacity]);
    const model = createChutesChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: impl, sleep: async () => undefined });
    const error = (await model.complete(REQUEST).catch((thrown: Error) => thrown)) as Error;
    expect(error.message).toBe(chutesFailure(429, 'capacity'));
    expect(error.message).not.toContain('Infrastructure');
    expect(models).toHaveLength(6);
    expect(records.every(entry => entry.status === 429 && entry.outcome === 'failed')).toBe(true);
    expect(JSON.stringify(records)).not.toContain('Infrastructure');
  });

  it('hands a model that is not offered over to the next at once, and stops at a refused key', async () => {
    const waits: number[] = [];
    const offered = sequence([[404, 'gone'], ok]);
    expect(await createChutesChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: offered.impl, sleep: async ms => void waits.push(ms) }).complete(REQUEST)).toEqual({ action: 'done' });
    expect(offered.models).toEqual(['Qwen/Qwen3.5-397B-A17B-TEE', 'deepseek-ai/DeepSeek-V3.2-TEE']);
    expect(waits).toEqual([]);
    const refused = sequence([[401, 'bad key'], ok]);
    await expect(createChutesChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: refused.impl }).complete(REQUEST)).rejects.toThrow('refused the key (401)');
    expect(refused.models).toHaveLength(1);
  });

  it('sorts a busy answer into capacity or a key limit, and nothing else', () => {
    expect(busyKind('{"detail":"Infrastructure is at maximum capacity, try again later"}')).toBe('capacity');
    expect(busyKind('{"detail":"No instances available"}')).toBe('capacity');
    expect(busyKind('{"detail":"Rate limit exceeded"}')).toBe('limit');
    expect(busyKind('{"detail":"Too many requests"}')).toBe('limit');
    expect(busyKind('something else')).toBeUndefined();
  });
});

describe('createOllamaChat', () => {
  it('asks the server on this Mac with no picture, and logs a local call', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const records: NetworkEntry[] = [];
    const model = createOllamaChat({ record: entry => records.push(entry), fetchImpl: fakeFetch(200, { message: { content: '{"action":"fail","reason":"x"}' } }, seen) });
    expect(await model.complete(REQUEST)).toEqual({ action: 'fail', reason: 'x' });
    const body = JSON.parse(String(seen[0].init?.body));
    expect(seen[0].url).toBe('http://127.0.0.1:11434/api/chat');
    expect(body.think).toBe(false);
    expect(body.messages[1]).not.toHaveProperty('images');
    expect(records[0]).toMatchObject({ purpose: 'local_model', host: '127.0.0.1', outcome: 'ok' });
  });

  it('says when the model is not installed or Ollama is not running', async () => {
    const records: NetworkEntry[] = [];
    const missing = createOllamaChat({ record: entry => records.push(entry), fetchImpl: fakeFetch(404, '{"error":"model not found"}') });
    await expect(missing.complete(REQUEST)).rejects.toThrow('is not installed in Ollama (404)');
    expect(records[0]).toMatchObject({ outcome: 'failed', status: 404 });
    const refused = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof fetch;
    await expect(createOllamaChat({ record: () => undefined, fetchImpl: refused }).complete(REQUEST)).rejects.toThrow('Ollama is not running');
  });
});
