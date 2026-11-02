import { describe, expect, it } from 'vitest';
import type { NetworkEntry, VisionRequest } from '@companyos/twin-core';
import { createOllamaVision, loopbackUrl, visionModelReady } from '../src/main/vision-ollama';

const PNG = new Uint8Array([137, 80, 78, 71, 1, 2, 3]);
const REQUEST: VisionRequest = {
  system: 'system text',
  prompt: 'prompt text',
  imagePng: PNG,
  schema: { type: 'object' },
  maxTokens: 800,
};

/** A fake Ollama server reply: a JSON body with the given status. */
function fakeFetch(status: number, body: unknown, seen: { url?: string; init?: RequestInit }[] = []): typeof fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    seen.push({ url: String(input), init });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status });
  }) as typeof fetch;
}

describe('loopbackUrl', () => {
  it('accepts plain http to this Mac, and refuses any other host or https', () => {
    expect(loopbackUrl('http://127.0.0.1:11434').hostname).toBe('127.0.0.1');
    expect(loopbackUrl('http://localhost:11434').hostname).toBe('localhost');
    expect(() => loopbackUrl('http://example.com:11434')).toThrow('must run on this Mac');
    expect(() => loopbackUrl('https://127.0.0.1:11434')).toThrow('must run on this Mac');
  });
});

describe('createOllamaVision', () => {
  it('sends the picture to the loopback address with hidden reasoning off and the schema as the format', async () => {
    const seen: { url?: string; init?: RequestInit }[] = [];
    const records: NetworkEntry[] = [];
    const vision = createOllamaVision({
      fetchImpl: fakeFetch(200, { message: { content: '{"capabilities":[]}' } }, seen),
      record: entry => records.push(entry),
      now: () => 1000,
    });
    expect(await vision.describe(REQUEST)).toEqual({ capabilities: [] });

    expect(seen[0].url).toBe('http://127.0.0.1:11434/api/chat');
    const body = JSON.parse(String(seen[0].init?.body));
    expect(body).toMatchObject({ model: 'qwen3-vl:2b-instruct', stream: false, think: false, format: { type: 'object' } });
    expect(body.options).toEqual({ temperature: 0, num_predict: 800 });
    expect(body.messages[1].images).toEqual([Buffer.from(PNG).toString('base64')]);
    expect(seen[0].init?.redirect).toBe('error');
  });

  it('records the call with where it went and how many bytes of picture, never the picture or the reply', async () => {
    const records: NetworkEntry[] = [];
    const vision = createOllamaVision({
      fetchImpl: fakeFetch(200, { message: { content: '{"capabilities":[{"name":"secret reply text"}]}' } }),
      record: entry => records.push(entry),
      now: () => 1000,
    });
    await vision.describe(REQUEST);
    expect(records).toEqual([{ ts: 1000, purpose: 'local_model', host: '127.0.0.1', path: '/api/chat', bytes: PNG.byteLength, outcome: 'ok' }]);
    expect(JSON.stringify(records)).not.toContain('secret reply text');
  });

  it('records a failure and throws a fixed sentence without the body, for a bad status, bad JSON or an empty answer', async () => {
    const records: NetworkEntry[] = [];
    const record = (entry: NetworkEntry) => records.push(entry);
    const down = createOllamaVision({ fetchImpl: fakeFetch(500, 'internal detail'), record });
    await expect(down.describe(REQUEST)).rejects.toThrow('returned 500');
    const notJson = createOllamaVision({ fetchImpl: fakeFetch(200, 'not json at all'), record });
    await expect(notJson.describe(REQUEST)).rejects.toThrow('not JSON');
    const empty = createOllamaVision({ fetchImpl: fakeFetch(200, { message: { content: '' } }), record });
    await expect(empty.describe(REQUEST)).rejects.toThrow('no answer');
    expect(records.every(entry => entry.outcome === 'failed')).toBe(true);
    expect(records).toHaveLength(3);
  });

  it('refuses to build against a non-loopback address', () => {
    expect(() => createOllamaVision({ baseUrl: 'http://10.0.0.5:11434', record: () => undefined })).toThrow('must run on this Mac');
  });
});

describe('visionModelReady', () => {
  it('is ready when the server answers and lists the model, and logs the check with no picture', async () => {
    const records: NetworkEntry[] = [];
    const tags = fakeFetch(200, { models: [{ name: 'qwen3-vl:2b-instruct' }] });
    expect(await visionModelReady({ fetchImpl: tags, record: entry => records.push(entry), now: () => 5 })).toBe('ready');
    expect(records).toEqual([{ ts: 5, purpose: 'local_model', host: '127.0.0.1', path: '/api/tags', bytes: 0, outcome: 'ok' }]);
  });

  it('reports a missing model separately from a server that is down', async () => {
    expect(await visionModelReady({ fetchImpl: fakeFetch(200, { models: [] }), record: () => undefined })).toBe('model_missing');
    const down = (async () => {
      throw new Error('refused');
    }) as unknown as typeof fetch;
    expect(await visionModelReady({ fetchImpl: down, record: () => undefined })).toBe('server_down');
  });
});
