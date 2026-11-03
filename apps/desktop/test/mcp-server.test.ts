import type { CaptureHitView } from '@companyos/twin-core';
import { afterEach, describe, expect, it } from 'vitest';
import { createLocalApi, type LocalApi } from '../src/main/local-api';
import { createMcpHandler } from '../src/main/mcp-server';

const TOKEN = 'c'.repeat(64);
const T = Date.UTC(2026, 10, 3, 9, 30);
const HITS: CaptureHitView[] = [
  { kind: 'screen', id: 's1', ts: T, app: 'textedit', snippet: 'Vendor review - Acme. Open: nobody owns the Q4 check-in call.' },
  { kind: 'audio', id: 'a1', ts: T + 60_000, app: null, snippet: 'send me the zone cost sheet before Friday' },
  { kind: 'keystroke', id: 'k1', ts: T + 120_000, app: 'slack', snippet: 'typed secret' },
];

let api: LocalApi | undefined;
afterEach(async () => {
  await api?.stop();
  api = undefined;
});

async function start(recapDays: Array<string | undefined> = []): Promise<number> {
  api = createLocalApi({
    host: '127.0.0.1',
    port: 0,
    token: () => TOKEN,
    search: request => HITS.filter(hit => !request.kind || hit.kind === request.kind),
    frameImage: async () => null,
    status: () => ({ screenState: 'on', audioState: 'off', screenCount: 2, audioCount: 1, mediaBytes: 0 }),
    recap: async day => {
      recapDays.push(day);
      return {
        day: day ?? '2026-11-03',
        summary: 'A vendor review, then zone costs.',
        items: [{ title: 'Acme vendor review', detail: 'Wrote the action items.', apps: ['textedit'], startTs: T, endTs: T + 50 * 60_000, minutes: 50 }],
        openLoops: ['Nobody owns the Q4 check-in call.'],
      };
    },
  });
  return api.start();
}

const call = (id: number, method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: '2.0', id, method, params });
const text = (reply: Record<string, unknown> | undefined) => ((reply?.result as { content: Array<{ text: string }> }).content[0].text);

describe('the MCP server', () => {
  it('introduces itself, lists its three tools, and ignores notifications', async () => {
    const handle = createMcpHandler({ port: 1, token: TOKEN });
    const init = await handle(call(1, 'initialize', { protocolVersion: '2025-06-18' }));
    expect(init?.result).toMatchObject({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'companyos' } });
    expect(await handle({ jsonrpc: '2.0', method: 'notifications/initialized' })).toBeUndefined();
    const list = await handle(call(2, 'tools/list'));
    expect((list?.result as { tools: Array<{ name: string }> }).tools.map(tool => tool.name)).toEqual(['search_memory', 'day_recap', 'capture_status']);
    expect((await handle(call(3, 'nope')))?.error).toMatchObject({ code: -32601 });
  });

  it('searches through the local API, which never serves typed text', async () => {
    const port = await start();
    const handle = createMcpHandler({ port, token: TOKEN });
    const all = text(await handle(call(4, 'tools/call', { name: 'search_memory', arguments: { query: '' } })));
    expect(all).toContain('textedit: Vendor review - Acme');
    expect(all).toContain('heard: send me the zone cost sheet');
    expect(all).not.toContain('typed secret');
    const speech = text(await handle(call(5, 'tools/call', { name: 'search_memory', arguments: { kind: 'audio' } })));
    expect(speech).not.toContain('Vendor review');
  });

  it('writes the day recap as plain text, passing the day on', async () => {
    const days: Array<string | undefined> = [];
    const port = await start(days);
    const handle = createMcpHandler({ port, token: TOKEN });
    const recap = text(await handle(call(6, 'tools/call', { name: 'day_recap', arguments: { day: '2026-11-02' } })));
    expect(days).toEqual(['2026-11-02']);
    expect(recap).toContain('Recap of 2026-11-02');
    expect(recap).toContain('(50 min, textedit): Acme vendor review. Wrote the action items.');
    expect(recap).toContain('Still open:\n- Nobody owns the Q4 check-in call.');
  });

  it('reports a wrong token, a missing token and an app that is not running as tool errors', async () => {
    const port = await start();
    const wrong = await createMcpHandler({ port, token: 'd'.repeat(64) })(call(7, 'tools/call', { name: 'capture_status' }));
    expect(wrong?.result).toMatchObject({ isError: true });
    expect(text(wrong)).toContain('token was refused');
    const none = await createMcpHandler({ port, token: '' })(call(8, 'tools/call', { name: 'capture_status' }));
    expect(text(none)).toContain('No API token');
    await api?.stop();
    const down = await createMcpHandler({ port, token: TOKEN })(call(9, 'tools/call', { name: 'capture_status' }));
    expect(text(down)).toContain('did not answer');
  });
});
