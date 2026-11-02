import { request as httpRequest, type IncomingHttpHeaders } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLocalApi, type LocalApi, type LocalApiOptions } from '../src/main/local-api';

/** Planted in a query and in an error. It must never appear in a reply. Never printed. */
const CANARY = 'SCREEN_OCR_CANARY_4471';
const TOKEN = 'a'.repeat(64);
const ROTATED = 'b'.repeat(64);
const FRAME_ID = 'f'.repeat(32);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const START_FAILED = 'The local API could not start. Its port may be in use.';

interface Reply {
  status: number;
  headers: IncomingHttpHeaders;
  body: Buffer;
}

interface CallOptions {
  method?: string;
  path?: string;
  host?: string;
  headers?: Record<string, string>;
}

/** One request to the local address. The Host header is set by the test, so a refused Host can be sent. */
function call(port: number, options: CallOptions = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port,
        method: options.method ?? 'GET',
        path: options.path ?? '/health',
        headers: { Host: options.host ?? `127.0.0.1:${port}`, ...options.headers },
      },
      res => {
        const chunks: Buffer[] = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function status(overrides: Partial<ReturnType<LocalApiOptions['status']>> = {}): ReturnType<LocalApiOptions['status']> {
  return { screenState: 'on', audioState: 'off', screenCount: 3, audioCount: 1, mediaBytes: 4096, ...overrides };
}

let api: LocalApi | undefined;

/** Starts the API on a free loopback port with the defaults the tests need. Each test may replace any of them. */
async function start(overrides: Partial<LocalApiOptions> = {}): Promise<number> {
  api = createLocalApi({
    host: '127.0.0.1',
    port: 0,
    token: () => TOKEN,
    search: () => [],
    frameImage: async () => null,
    status: () => status(),
    ...overrides,
  });
  return api.start();
}

afterEach(async () => {
  await api?.stop();
  api = undefined;
  vi.restoreAllMocks();
});

describe('local API', () => {
  it('answers the health check without a token and returns no data', async () => {
    const port = await start();
    const reply = await call(port, { path: '/health' });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ ok: true });
  });

  it('refuses any Host other than 127.0.0.1 or localhost, even with the right token', async () => {
    const port = await start();
    for (const host of [`evil.example:${port}`, `localhost.evil.example:${port}`, 'example.com']) {
      const reply = await call(port, { path: '/v1/status', host, headers: bearer(TOKEN) });
      expect(reply.status, `Host ${host}`).toBe(403);
    }
    const loopback = await call(port, { path: '/v1/status', host: `localhost:${port}`, headers: bearer(TOKEN) });
    expect(loopback.status).toBe(200);
  });

  it('refuses any request that carries an Origin header, including the health check', async () => {
    const port = await start();
    const withOrigin = await call(port, {
      path: '/v1/status',
      headers: { ...bearer(TOKEN), Origin: 'https://example.com' },
    });
    expect(withOrigin.status).toBe(403);
    const health = await call(port, { path: '/health', headers: { Origin: 'null' } });
    expect(health.status).toBe(403);
  });

  it('answers 401 without a token, or with a wrong one, and names the bearer scheme', async () => {
    const port = await start();
    const none = await call(port, { path: '/v1/status' });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    const wrong = await call(port, { path: '/v1/status', headers: bearer('c'.repeat(64)) });
    expect(wrong.status).toBe(401);
  });

  it('answers 405 to every method but GET, with or without a token', async () => {
    const port = await start();
    const bare = await call(port, { method: 'POST', path: '/v1/search' });
    expect(bare.status).toBe(405);
    expect(bare.headers.allow).toBe('GET');
    const signed = await call(port, { method: 'POST', path: '/v1/search', headers: bearer(TOKEN) });
    expect(signed.status).toBe(405);
    const health = await call(port, { method: 'DELETE', path: '/health' });
    expect(health.status).toBe(405);
  });

  it('returns only the counts and states on the status route', async () => {
    const port = await start();
    const reply = await call(port, { path: '/v1/status', headers: bearer(TOKEN) });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString('utf8'))).toEqual(status());
  });

  it('searches with the query, the kind and the range, and returns the hits', async () => {
    const seen: unknown[] = [];
    const hit = { kind: 'screen', id: FRAME_ID, ts: 1_700_000_000_000, app: 'Notes', snippet: 'quarterly plan' };
    const port = await start({
      search: request => {
        seen.push(request);
        return [hit];
      },
    });
    const reply = await call(port, {
      path: '/v1/search?q=quarterly%20plan&kind=screen&app=Notes&from=1000',
      headers: bearer(TOKEN),
    });
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body.toString('utf8'))).toEqual({ hits: [hit] });
    expect(seen[0]).toMatchObject({ text: 'quarterly plan', kind: 'screen', app: 'Notes', from: 1000 });
    expect((seen[0] as { to: number }).to).toBeGreaterThan(1000);
  });

  it('refuses an unknown kind or an over-long query before the engine runs, and never echoes it', async () => {
    const search = vi.fn(() => []);
    const port = await start({ search });
    const badKind = await call(port, { path: `/v1/search?q=${CANARY}&kind=video`, headers: bearer(TOKEN) });
    expect(badKind.status).toBe(400);
    expect(badKind.body.toString('utf8')).not.toContain(CANARY);
    const long = await call(port, { path: `/v1/search?q=${'x'.repeat(201)}${CANARY}`, headers: bearer(TOKEN) });
    expect(long.status).toBe(400);
    expect(long.body.toString('utf8')).not.toContain(CANARY);
    expect(search).not.toHaveBeenCalled();
  });

  it('answers a generic message when the engine refuses a search, without its text', async () => {
    const port = await start({
      search: () => {
        throw new Error(`Invalid search: ${CANARY}`);
      },
    });
    const reply = await call(port, { path: '/v1/search?q=hello', headers: bearer(TOKEN) });
    expect(reply.status).toBe(400);
    expect(reply.body.toString('utf8')).not.toContain(CANARY);
  });

  it('serves a stored image as JPEG bytes', async () => {
    const requested: string[] = [];
    const port = await start({
      frameImage: async id => {
        requested.push(id);
        return id === FRAME_ID ? JPEG : null;
      },
    });
    const reply = await call(port, { path: `/v1/frames/${FRAME_ID}`, headers: bearer(TOKEN) });
    expect(reply.status).toBe(200);
    expect(reply.headers['content-type']).toBe('image/jpeg');
    expect(reply.body.equals(JPEG)).toBe(true);
    expect(requested).toEqual([FRAME_ID]);
  });

  it('answers 404 for a malformed image id without reading, and for an image that is gone', async () => {
    const frameImage = vi.fn(async () => null);
    const port = await start({ frameImage });
    const malformed = await call(port, { path: '/v1/frames/not-an-id', headers: bearer(TOKEN) });
    expect(malformed.status).toBe(404);
    expect(frameImage).not.toHaveBeenCalled();
    const gone = await call(port, { path: `/v1/frames/${FRAME_ID}`, headers: bearer(TOKEN) });
    expect(gone.status).toBe(404);
  });

  it('marks every answer, refusals included, as uncacheable and sniff-proof', async () => {
    const port = await start();
    const replies = await Promise.all([
      call(port, { path: '/health' }),
      call(port, { path: '/v1/status' }),
      call(port, { method: 'POST', path: '/v1/search' }),
      call(port, { path: '/v1/status', host: 'evil.example', headers: bearer(TOKEN) }),
      call(port, { path: '/v1/status', headers: bearer(TOKEN) }),
    ]);
    for (const reply of replies) {
      expect(reply.headers['cache-control']).toBe('no-store');
      expect(reply.headers['x-content-type-options']).toBe('nosniff');
    }
  });

  it('stops accepting the old token at once when the token is rotated', async () => {
    let current = TOKEN;
    const port = await start({ token: () => current });
    expect((await call(port, { path: '/v1/status', headers: bearer(TOKEN) })).status).toBe(200);
    current = ROTATED;
    expect((await call(port, { path: '/v1/status', headers: bearer(TOKEN) })).status).toBe(401);
    expect((await call(port, { path: '/v1/status', headers: bearer(ROTATED) })).status).toBe(200);
  });

  it('rejects with a fixed sentence when the port is already in use', async () => {
    const port = await start();
    const second = createLocalApi({
      host: '127.0.0.1',
      port,
      token: () => TOKEN,
      search: () => [],
      frameImage: async () => null,
      status: () => status(),
    });
    await expect(second.start()).rejects.toThrow(START_FAILED);
  });

  it('refuses connections once stopped', async () => {
    const port = await start();
    await api?.stop();
    api = undefined;
    await expect(call(port, { path: '/health' })).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });

  it('writes nothing to the console while it serves and refuses requests', async () => {
    const consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map(method =>
      vi.spyOn(console, method).mockImplementation(() => undefined),
    );
    const port = await start({ search: () => [] });
    await call(port, { path: '/health' });
    await call(port, { path: `/v1/search?q=${CANARY}`, headers: bearer(TOKEN) });
    await call(port, { path: `/v1/search?q=${CANARY}`, headers: bearer('d'.repeat(64)) });
    await call(port, { method: 'POST', path: '/v1/search' });
    for (const spy of consoleSpies) expect(spy).not.toHaveBeenCalled();
  });
});
