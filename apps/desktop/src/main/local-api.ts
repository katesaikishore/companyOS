import { createHash, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { CaptureHitView, CaptureKind, CaptureSearchRequest, TwinStatus } from '@companyos/twin-core';

/**
 * A read-only API on the loopback address, for other tools on this device. It is off until the person turns it on, and
 * every route except /health needs the bearer token. A request is refused when its Host is not the loopback name, or when
 * it carries an Origin header, so a web page cannot read it through the browser, even by DNS rebinding. Nothing is logged,
 * and every error is a fixed sentence that never repeats what was sent.
 */
export const LOCAL_API_HOST = '127.0.0.1';
export const LOCAL_API_PORT = 3838;

const HOST_NAMES = new Set(['127.0.0.1', 'localhost']);
const FRAME_PATH = /^\/v1\/frames\/([^/]+)$/;
const FRAME_ID = /^[0-9a-f]{32}$/;
const TIME_PARAM = /^\d{1,15}$/;
const BEARER = /^Bearer (.+)$/i;
const MAX_QUERY_CHARS = 200;
const MAX_APP_CHARS = 200;
/** The newest item may be a little ahead of this clock, so the default range reaches past now. */
const LOOK_AHEAD_MS = 2 * 60 * 60 * 1000;
const START_FAILED = 'The local API could not start. Its port may be in use.';
const JSON_TYPE = 'application/json; charset=utf-8';
const JPEG_TYPE = 'image/jpeg';
const NOT_FOUND = 'Not found.';

/** The capture channels' states and counts. It holds no text, so it is safe to return. */
export type LocalApiStatus = Pick<
  TwinStatus['capture'],
  'screenState' | 'audioState' | 'screenCount' | 'audioCount' | 'mediaBytes'
>;

export interface LocalApiOptions {
  host: string;
  port: number;
  /** Read on every request, so a rotated token stops the old one at once. */
  token: () => string;
  search: (request: CaptureSearchRequest) => CaptureHitView[];
  /** The JPEG bytes of one stored image, or null when it is gone or cannot be read. */
  frameImage: (id: string) => Promise<Buffer | null>;
  status: () => LocalApiStatus;
}

export interface LocalApi {
  /** Binds the address and resolves with the bound port. Rejects with a fixed sentence when it cannot bind. */
  start(): Promise<number>;
  /** Closes the server and any open connection. */
  stop(): Promise<void>;
}

export function createLocalApi(options: LocalApiOptions): LocalApi {
  let server: Server | undefined;

  return {
    start: () =>
      new Promise<number>((resolve, reject) => {
        const created = createServer((request, response) => {
          void respond(options, request, response).catch(() => {
            if (response.headersSent) response.end();
            else json(response, 500, { error: 'Server error.' });
          });
        });
        // A client that stalls on its headers or its request is dropped, so it cannot hold a connection open for long.
        created.headersTimeout = 10_000;
        created.requestTimeout = 15_000;
        const onError = () => reject(new Error(START_FAILED));
        created.once('error', onError);
        created.listen(options.port, options.host, () => {
          created.off('error', onError);
          // Errors after a successful bind are ignored. They are not logged, because a log could name the file or the port.
          created.on('error', () => undefined);
          server = created;
          const address = created.address();
          resolve(typeof address === 'object' && address !== null ? address.port : options.port);
        });
      }),
    stop: () =>
      new Promise<void>(resolve => {
        const running = server;
        server = undefined;
        if (!running) return resolve();
        running.close(() => resolve());
        running.closeAllConnections();
      }),
  };
}

/** The most of a refused request's body that is read. Past it, the connection is closed. */
const MAX_DRAINED_BYTES = 64 * 1024;

/** Checks the Host and Origin, then the method, then the token, then the route. Each refusal is a fixed sentence. */
async function respond(options: LocalApiOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  // The body of a refused request is drained, so the client receives the answer rather than a reset connection. The drain
  // stops at MAX_DRAINED_BYTES, and the connection is closed past it, so a large body cannot hold the server.
  let drained = 0;
  request.on('data', (chunk: Buffer) => {
    drained += chunk.length;
    if (drained > MAX_DRAINED_BYTES) request.destroy();
  });
  request.resume();
  if (!hostAllowed(request.headers.host) || request.headers.origin !== undefined) {
    return json(response, 403, { error: 'Forbidden.' });
  }
  if (request.method !== 'GET') return json(response, 405, { error: 'Method not allowed.' }, { Allow: 'GET' });
  const url = parseTarget(request.url);
  if (!url) return json(response, 400, { error: 'Bad request.' });
  // The health check says only that the API is up. It is the one route that needs no token, and it returns no data.
  if (url.pathname === '/health') return json(response, 200, { ok: true });
  if (!authorised(request.headers.authorization, options.token())) {
    return json(response, 401, { error: 'Unauthorized.' }, { 'WWW-Authenticate': 'Bearer' });
  }
  if (url.pathname === '/v1/status') return json(response, 200, options.status());
  if (url.pathname === '/v1/search') return searchReply(options, url.searchParams, response);
  const frame = FRAME_PATH.exec(url.pathname)?.[1];
  if (frame !== undefined) return frameReply(options, frame, response);
  return json(response, 404, { error: NOT_FOUND });
}

function hostAllowed(host: string | undefined): boolean {
  if (host === undefined) return false;
  return HOST_NAMES.has(host.replace(/:\d+$/, '').toLowerCase());
}

function parseTarget(target: string | undefined): URL | undefined {
  try {
    return new URL(target ?? '/', `http://${LOCAL_API_HOST}`);
  } catch {
    return undefined;
  }
}

/** True when the header carries the token. Both sides are hashed first, so the comparison takes the same time for any length. */
function authorised(header: string | undefined, expected: string): boolean {
  const presented = header === undefined ? undefined : BEARER.exec(header)?.[1];
  if (presented === undefined || expected === '') return false;
  return timingSafeEqual(sha256(presented), sha256(expected));
}

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

function searchReply(options: LocalApiOptions, params: URLSearchParams, response: ServerResponse): void {
  const request = searchRequest(params);
  if (!request) return json(response, 400, { error: 'The search is not valid.' });
  try {
    return json(response, 200, { hits: options.search(request) });
  } catch {
    // The engine's own message can quote the query, so it is not sent on.
    return json(response, 400, { error: 'The search could not run with these settings.' });
  }
}

/** The search from the query string. Anything out of range is refused here, before the engine sees it. */
function searchRequest(params: URLSearchParams): CaptureSearchRequest | undefined {
  const text = params.get('q') ?? '';
  const app = params.get('app') ?? '';
  const kind = kindParam(params.get('kind'));
  const from = timeParam(params.get('from'), 0);
  const to = timeParam(params.get('to'), Date.now() + LOOK_AHEAD_MS);
  if (text.length > MAX_QUERY_CHARS || app.length > MAX_APP_CHARS) return undefined;
  if (kind === undefined || from === undefined || to === undefined) return undefined;
  const request: CaptureSearchRequest = { text, from, to };
  if (kind) request.kind = kind;
  if (app) request.app = app;
  return request;
}

/** Null when the parameter is absent, and undefined when it names neither kind. */
function kindParam(value: string | null): CaptureKind | null | undefined {
  if (value === null) return null;
  return value === 'screen' || value === 'audio' ? value : undefined;
}

function timeParam(value: string | null, fallback: number): number | undefined {
  if (value === null) return fallback;
  return TIME_PARAM.test(value) ? Number(value) : undefined;
}

async function frameReply(options: LocalApiOptions, id: string, response: ServerResponse): Promise<void> {
  if (!FRAME_ID.test(id)) return json(response, 404, { error: NOT_FOUND });
  const bytes = await options.frameImage(id);
  if (!bytes) return json(response, 404, { error: NOT_FOUND });
  return reply(response, 200, bytes, JPEG_TYPE);
}

/** Every answer is uncacheable and sniff-proof, and closes its connection, so nothing is kept between requests. */
const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Connection: 'close' };

function json(response: ServerResponse, status: number, value: unknown, extra: Record<string, string> = {}): void {
  reply(response, status, JSON.stringify(value), JSON_TYPE, extra);
}

function reply(
  response: ServerResponse,
  status: number,
  body: Buffer | string,
  type: string,
  extra: Record<string, string> = {},
): void {
  response.writeHead(status, {
    ...SECURITY_HEADERS,
    'Content-Type': type,
    'Content-Length': Buffer.byteLength(body),
    ...extra,
  });
  response.end(body);
}
