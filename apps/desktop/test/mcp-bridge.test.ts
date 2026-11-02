import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
// The bridge is plain Node with no build step, so the test loads it directly.
// @ts-expect-error the bridge is an untyped .mjs script
import { handleMessage, searchQuery, serve, TOOLS } from '../scripts/mcp-bridge.mjs';

const BRIDGE = fileURLToPath(new URL('../scripts/mcp-bridge.mjs', import.meta.url));
const TOKEN = 'test-token-123';
const TOO_LARGE_TEXT = 'The reply is too large. Narrow the search with a kind, a time range or more words.';

interface Seen {
  path: string;
  auth: string | undefined;
}

/** Polls until the check passes, or gives up after two seconds. The caller's assertions then say what happened. */
async function waitFor(done: () => boolean): Promise<void> {
  for (let i = 0; i < 200 && !done(); i++) await new Promise(resolve => setTimeout(resolve, 10));
}

describe('MCP bridge', () => {
  let api: Server;
  let port: number;
  let seen: Seen[];
  let status: number;
  let large: boolean;

  beforeEach(async () => {
    seen = [];
    status = 200;
    large = false;
    api = createServer((request: IncomingMessage, response: ServerResponse) => {
      seen.push({ path: request.url ?? '', auth: request.headers.authorization });
      response.writeHead(status, { 'Content-Type': 'application/json' });
      if (large) return response.end('x'.repeat(64 * 1024 + 1));
      response.end(request.url?.startsWith('/v1/status') ? '{"screenState":"capturing"}' : '{"hits":[]}');
    });
    await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
    port = (api.address() as { port: number }).port;
  });

  afterEach(async () => {
    await new Promise<void>(resolve => api.close(() => resolve()));
  });

  const config = () => ({ port, token: TOKEN });

  it('answers initialize with the protocol version and the tools capability', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, config());
    expect(reply.result.protocolVersion).toBe('2025-06-18');
    expect(reply.result.capabilities).toEqual({ tools: {} });
    expect(reply.result.serverInfo.name).toBe('companyos-twin');
  });

  it('lists only read-only tools', () => {
    expect(TOOLS.map((tool: { name: string }) => tool.name)).toEqual(['twin_status', 'twin_search']);
    for (const tool of TOOLS) expect(tool.annotations.readOnlyHint).toBe(true);
  });

  it('calls the local API with the token and returns its reply as text', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'twin_status', arguments: {} } }, config());
    expect(reply.result.isError).toBe(false);
    expect(reply.result.content[0].text).toBe('{"screenState":"capturing"}');
    expect(seen).toEqual([{ path: '/v1/status', auth: `Bearer ${TOKEN}` }]);
  });

  it('builds the search query from the arguments', async () => {
    await handleMessage(
      { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'twin_search', arguments: { text: 'invoice', kind: 'screen', from: 1000, to: 2000 } } },
      config(),
    );
    expect(seen[0].path).toBe('/v1/search?q=invoice&kind=screen&from=1000&to=2000');
  });

  it('refuses a bad search before it reaches the API', async () => {
    const reply = await handleMessage(
      { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'twin_search', arguments: { kind: 'keystrokes' } } },
      config(),
    );
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/screen or audio/);
    expect(seen).toEqual([]);
  });

  it('validates the search arguments on their own', () => {
    expect(searchQuery({ text: 'a'.repeat(201) })).toHaveProperty('error');
    expect(searchQuery({ from: -1 })).toHaveProperty('error');
    expect(searchQuery({ to: 1.5 })).toHaveProperty('error');
    expect(searchQuery({ text: 'ok' })).toEqual({ query: 'q=ok' });
  });

  it('says so, and calls nothing, when no token is configured', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'twin_status' } }, { port, token: '' });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/token is not set/);
    expect(seen).toEqual([]);
  });

  it('reports a refused request by its status, without echoing the request', async () => {
    status = 401;
    const reply = await handleMessage({ jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'twin_status' } }, config());
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/HTTP 401/);
  });

  it('reports an unreachable API in a fixed sentence', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name: 'twin_status' } }, { port: 1, token: TOKEN });
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toMatch(/not reachable/);
  });

  it('names the size limit, not an unreachable API, when a reply is too large', async () => {
    large = true;
    const reply = await handleMessage(
      { jsonrpc: '2.0', id: 12, method: 'tools/call', params: { name: 'twin_search', arguments: { text: 'invoice' } } },
      config(),
    );
    expect(reply.result.isError).toBe(true);
    expect(reply.result.content[0].text).toBe(TOO_LARGE_TEXT);
    expect(reply.result.content[0].text).not.toMatch(/not reachable/);
  });

  it('answers an unknown method with a JSON-RPC error, and a notification with nothing', async () => {
    const reply = await handleMessage({ jsonrpc: '2.0', id: 8, method: 'resources/list' }, config());
    expect(reply.error.code).toBe(-32601);
    expect(await handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }, config())).toBeUndefined();
  });

  it('answers a no-id message whose method is not text with nothing, and without throwing', async () => {
    await expect(handleMessage({ jsonrpc: '2.0', method: 5 }, config())).resolves.toBeUndefined();
    await expect(handleMessage({ jsonrpc: '2.0', method: {} }, config())).resolves.toBeUndefined();
    const reply = await handleMessage({ jsonrpc: '2.0', id: 13, method: 5 }, config());
    expect(reply.error.code).toBe(-32601);
  });

  it('keeps serving after a message that fails inside the handler, and answers it with a fixed error', async () => {
    const input = new PassThrough();
    let out = '';
    let err = '';
    const output = new Writable({ write: (chunk, _encoding, done) => { out += chunk; done(); } });
    const errors = new Writable({ write: (chunk, _encoding, done) => { err += chunk; done(); } });
    // Reading the token throws, the way an unexpected failure inside the handler would.
    const broken = { port, get token(): string { throw new Error('boom'); } };
    serve(broken, input, output, errors);
    input.write('{"jsonrpc":"2.0","id":9,"method":"tools/call","params":{"name":"twin_status"}}\n');
    input.write('{"jsonrpc":"2.0","id":10,"method":"ping"}\n');
    await waitFor(() => out.includes('"id":9') && out.includes('"id":10') && err !== '');
    input.end();
    const lines = out.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.find(line => line.id === 9).error).toEqual({ code: -32603, message: 'The bridge could not answer this message.' });
    expect(lines.find(line => line.id === 10).result).toEqual({});
    expect(err).toBe('The bridge could not answer one message.\n');
    expect(err).not.toContain('boom');
  });

  it('runs as a stdio server: one message per line in, one reply per line out', async () => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, COMPANYOS_API_PORT: String(port), COMPANYOS_API_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
    });
    child.stdin.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    child.stdin.write('not json\n');
    child.stdin.write('{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"twin_status"}}\n');
    await new Promise(resolve => setTimeout(resolve, 1500));
    child.stdin.end();
    child.kill();
    const lines = out.trim().split('\n').map(line => JSON.parse(line));
    expect(lines.find(line => line.id === 1).result.serverInfo.name).toBe('companyos-twin');
    expect(lines.find(line => line.id === null).error.code).toBe(-32700);
    expect(lines.find(line => line.id === 2).result.content[0].text).toBe('{"screenState":"capturing"}');
  });

  it('keeps the stdio server running after a notification whose method is not text', async () => {
    const child = spawn(process.execPath, [BRIDGE], {
      env: { ...process.env, COMPANYOS_API_PORT: String(port), COMPANYOS_API_TOKEN: TOKEN },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    child.stdin.on('error', () => undefined);
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      out += chunk;
    });
    child.stdin.write('{"jsonrpc":"2.0","method":5}\n');
    child.stdin.write('{"jsonrpc":"2.0","id":3,"method":"ping"}\n');
    await waitFor(() => out.includes('"id":3'));
    const alive = child.exitCode === null && child.signalCode === null;
    child.stdin.end();
    child.kill();
    expect(alive).toBe(true);
    expect(out.trim().split('\n').map(line => JSON.parse(line))).toEqual([{ jsonrpc: '2.0', id: 3, result: {} }]);
  });
});
