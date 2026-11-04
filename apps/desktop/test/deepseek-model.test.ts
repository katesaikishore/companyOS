import { describe, expect, it } from 'vitest';
import type { CompletionRequest, NetworkEntry } from '@companyos/twin-core';
import { createDeepSeekChat, deepseekFailure, validDeepSeekKey } from '../src/main/deepseek-model';

const KEY = 'sk-0123456789abcdef0123456789abcdef';
const REQUEST: CompletionRequest = { system: 'system text', prompt: 'goal and controls', schema: { type: 'object', properties: { action: { type: 'string' } } }, maxTokens: 600 };

function replying(answers: Array<[number, unknown, string?]>, seen: { url: string; init?: RequestInit }[] = []): typeof fetch {
  let i = 0;
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    const [status, body, retryAfter] = answers[Math.min(i++, answers.length - 1)];
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: retryAfter ? { 'retry-after': retryAfter } : {} });
  }) as typeof fetch;
}
const answer = (text: string, extra: Record<string, unknown> = {}) => ({
  status: 'completed',
  output: [{ type: 'reasoning', content: [] }, { type: 'message', content: [{ type: 'output_text', text }] }],
  ...extra,
});
const ok: [number, unknown] = [200, answer('{"action":"done"}')];

describe('createDeepSeekChat', () => {
  it('asks DeepSeek V4.1 Flash on the Responses API with thinking off, holds the reply to the schema, and logs the call', async () => {
    const seen: { url: string; init?: RequestInit }[] = [];
    const records: NetworkEntry[] = [];
    const model = createDeepSeekChat({ apiKey: KEY, sharesScreenText: true, record: entry => records.push(entry), fetchImpl: replying([ok], seen), now: () => 5 });
    expect(await model.complete(REQUEST)).toEqual({ action: 'done' });
    expect(seen[0].url).toBe('https://api.deepseek.com/responses');
    expect(seen[0].init?.redirect).toBe('error');
    expect(JSON.parse(String(seen[0].init?.body))).toEqual({
      model: 'deepseek-flash',
      instructions: 'system text',
      input: 'goal and controls',
      text: { format: { type: 'json_schema', name: 'reply', schema: REQUEST.schema } },
      reasoning: { effort: 'none' },
      max_output_tokens: 600,
      temperature: 0,
    });
    expect(records).toEqual([{ ts: 5, purpose: 'remote_model', host: 'api.deepseek.com', path: '/responses', bytes: Buffer.byteLength(String(seen[0].init?.body)), outcome: 'ok', sharedScreenText: true }]);
  });

  it('waits and tries once more when DeepSeek is busy, and stops at once at a refused key, never showing the body', async () => {
    const waits: number[] = [];
    const busy = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: replying([[503, 'overloaded detail', '2'], ok]), sleep: async ms => void waits.push(ms) });
    expect(await busy.complete(REQUEST)).toEqual({ action: 'done' });
    expect(waits).toEqual([2000]);

    const seen: { url: string; init?: RequestInit }[] = [];
    const records: NetworkEntry[] = [];
    const refused = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: replying([[401, 'bad key detail'], ok], seen) });
    const error = (await refused.complete(REQUEST).catch((thrown: Error) => thrown)) as Error;
    expect(error.message).toBe(deepseekFailure(401));
    expect(seen).toHaveLength(1);
    expect(JSON.stringify(records)).not.toContain(KEY);
    expect(JSON.stringify(records)).not.toContain('detail');
  });

  it('says when a reply is not JSON or was cut off, when DeepSeek is silent too long, and passes on a stop as the caller’s own', async () => {
    const blank = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: replying([[200, answer('   ')]]) });
    await expect(blank.complete(REQUEST)).rejects.toThrow('not JSON');
    const cut = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: replying([[200, answer('{"act', { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } })]]) });
    await expect(cut.complete(REQUEST)).rejects.toThrow('ran out of room');
    const filtered = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: replying([[200, answer('', { status: 'incomplete', incomplete_details: { reason: 'content_filter' } })]]) });
    await expect(filtered.complete(REQUEST)).rejects.toThrow('declined this step');
    const silentFetch = (async (_input: RequestInfo | URL, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => init?.signal?.addEventListener('abort', () => reject(init.signal?.reason)))) as typeof fetch;
    const silent = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: silentFetch, callTimeoutMs: 10 });
    await expect(silent.complete(REQUEST)).rejects.toThrow('did not answer within');
    const records: NetworkEntry[] = [];
    const stopped = createDeepSeekChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: silentFetch });
    const error = (await stopped.complete({ ...REQUEST, signal: AbortSignal.timeout(10) }).catch((thrown: Error) => thrown)) as Error;
    expect(error.name).toBe('TimeoutError');
    expect(records.map(entry => entry.outcome)).toEqual(['cancelled']);
  });

  it('takes a DeepSeek key and nothing that only looks like one', () => {
    expect(validDeepSeekKey(KEY)).toBe(true);
    expect(validDeepSeekKey('sk-ant-api03-0123456789abcdef0123456789')).toBe(false);
    expect(validDeepSeekKey('cpk_0123456789abcdef')).toBe(false);
    expect(validDeepSeekKey('sk-short')).toBe(false);
    expect(() => createDeepSeekChat({ apiKey: 'sk-ant-x', sharesScreenText: false, record: () => undefined })).toThrow('sk- format');
  });

  it('tells the person what each failure means', () => {
    expect(deepseekFailure(402)).toContain('no balance');
    expect(deepseekFailure(429)).toContain('Wait a minute');
    expect(deepseekFailure(503)).toContain('on its side (503)');
    expect(deepseekFailure(418)).toBe('DeepSeek returned 418.');
  });
});
