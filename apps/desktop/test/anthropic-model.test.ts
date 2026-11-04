import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '@companyos/twin-core';
import { createAnthropicChat, strictSchema, validAnthropicKey } from '../src/main/anthropic-model';

const KEY = `sk-ant-api03-${'a'.repeat(40)}`;
const SCHEMA = { type: 'object', properties: { action: { type: 'string', enum: ['click', 'done'] }, ref: { type: 'string', enum: ['', '@s:e1'] }, reason: { type: 'string' } }, required: ['action', 'ref', 'reason'] };

function fakeFetch(status: number, body: unknown) {
  const seen: Array<{ url: string; init: RequestInit }> = [];
  const impl = async (url: unknown, init?: RequestInit) => {
    seen.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'request-id': 'req_1' } });
  };
  return { seen, impl: impl as unknown as typeof fetch };
}

function message(text: string, stop_reason = 'end_turn') {
  return { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text }], stop_reason, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 5 } };
}

describe('the task operator on Anthropic', () => {
  it('asks Claude Opus 5.5 for one JSON object held to the schema, with fallbacks on, and returns it', async () => {
    const { seen, impl } = fakeFetch(200, message('{"action":"click","ref":"@s:e1","reason":"open it"}'));
    const records: NetworkEntry[] = [];
    const model = createAnthropicChat({ apiKey: KEY, sharesScreenText: false, record: entry => records.push(entry), fetchImpl: impl, now: () => 7 });
    const reply = await model.complete({ system: 'sys', prompt: 'Goal: open it', schema: SCHEMA, maxTokens: 600 });
    expect(reply).toEqual({ action: 'click', ref: '@s:e1', reason: 'open it' });
    expect(seen[0].url).toContain('https://api.anthropic.com/v1/messages');
    const headers = new Headers(seen[0].init.headers);
    expect(headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    const body = JSON.parse(String(seen[0].init.body));
    expect(body).toMatchObject({ model: 'claude-opus-5-5', system: 'sys', fallbacks: 'default', messages: [{ role: 'user', content: 'Goal: open it' }] });
    expect(body.max_tokens).toBeGreaterThanOrEqual(16_000);
    expect(body.output_config.effort).toBe('low');
    expect(body.output_config.format).toEqual({ type: 'json_schema', schema: { ...SCHEMA, additionalProperties: false } });
    expect(records).toEqual([expect.objectContaining({ ts: 7, purpose: 'remote_model', host: 'api.anthropic.com', path: '/v1/messages', outcome: 'ok', sharedScreenText: false })]);
  });

  it('says in plain words when the key is refused, and ledgers the status', async () => {
    const { impl } = fakeFetch(401, { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } });
    const records: NetworkEntry[] = [];
    const model = createAnthropicChat({ apiKey: KEY, sharesScreenText: true, record: entry => records.push(entry), fetchImpl: impl });
    await expect(model.complete({ system: 's', prompt: 'p', schema: SCHEMA, maxTokens: 600 })).rejects.toThrow('Anthropic refused the key (401). Remove the key on the Tasks page and save one that works.');
    expect(records[0]).toMatchObject({ outcome: 'failed', status: 401, sharedScreenText: true });
  });

  it('reports a declined step and a reply that is not JSON as failures, not as actions', async () => {
    const declined = createAnthropicChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: fakeFetch(200, message('', 'refusal')).impl });
    await expect(declined.complete({ system: 's', prompt: 'p', schema: SCHEMA, maxTokens: 600 })).rejects.toThrow('Claude declined this step.');
    const prose = createAnthropicChat({ apiKey: KEY, sharesScreenText: false, record: () => undefined, fetchImpl: fakeFetch(200, message('I will click it.')).impl });
    await expect(prose.complete({ system: 's', prompt: 'p', schema: SCHEMA, maxTokens: 600 })).rejects.toThrow('not JSON');
  });

  it('takes only keys in the sk-ant- shape, and marks every object in a schema closed', () => {
    expect(validAnthropicKey(KEY)).toBe(true);
    expect(validAnthropicKey('cpk_abc')).toBe(false);
    expect(validAnthropicKey(`sk-ant-${'a'.repeat(10)} x`)).toBe(false);
    expect(strictSchema({ type: 'object', properties: { steps: { type: 'array', items: { type: 'object', properties: {} } } } })).toEqual({
      type: 'object',
      additionalProperties: false,
      properties: { steps: { type: 'array', items: { type: 'object', properties: {}, additionalProperties: false } } },
    });
  });
});
