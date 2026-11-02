/**
 * OAuth 2.0 authorization code flow with PKCE (S256) for the cloud connectors.
 *
 * The browser signs the person in with the provider. The provider redirects to a listener on 127.0.0.1 that only this
 * function opens, for one flow, on a free port. The listener checks the state, takes the code, and closes. The code is
 * exchanged at the provider's token endpoint. Every request this module sends is reported through `record`. Messages
 * never contain a code, a token, a state or a verifier.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ConfiguredProvider } from './providers';

/** The tokens a provider issued. `expiresAt` is epoch milliseconds. */
export interface Tokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/** One request this connector sent. It carries the path only: no query string, no body, no header, no token. */
export interface NetworkEntry {
  host: string;
  path: string;
  /** 0 when the request failed before any response arrived. */
  status: number;
  /** Bytes read from the response. */
  bytes: number;
  /** Epoch milliseconds. */
  at: number;
}

export interface NetworkDeps {
  fetch: typeof fetch;
  record(entry: NetworkEntry): void;
  /** Epoch milliseconds. Defaults to Date.now. */
  now?: () => number;
}

export interface AuthorizeDeps extends NetworkDeps {
  /** Opens the authorization URL in the person's browser. */
  openUrl(url: string): Promise<void>;
  /** How long to wait for the browser to come back. Defaults to three minutes. */
  timeoutMs?: number;
}

export type CloudConnectorErrorCode =
  | 'not_configured'
  | 'timeout'
  | 'state'
  | 'denied'
  | 'callback'
  | 'open'
  | 'network'
  | 'exchange'
  | 'reauth'
  | 'api'
  | 'rate_limited'
  | 'too_large'
  | 'bad_response'
  | 'window'
  | 'provider'
  | 'unavailable'
  | 'store';

/** An error whose message is a fixed sentence. It never carries a code, a token, a state or response text. */
export class CloudConnectorError extends Error {
  readonly code: CloudConnectorErrorCode;

  constructor(code: CloudConnectorErrorCode, message: string) {
    super(message);
    this.name = 'CloudConnectorError';
    this.code = code;
  }
}

export const NOT_CONFIGURED_MESSAGE = 'This connector is not configured yet, so it cannot connect.';
export const SIGN_IN_TIMEOUT_MS = 3 * 60 * 1000;
export const TIMEOUT_MESSAGE = 'Sign-in timed out after 3 minutes. Nothing was connected.';
export const REAUTH_MESSAGE = 'Your sign-in has expired. Connect the account again.';
/** Responses are read up to this many bytes. A larger response is refused before it is parsed. */
export const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
/** A token is treated as expired this long before its real expiry, so a request does not start with a dead token. */
export const EXPIRY_SKEW_MS = 60_000;

const CALLBACK_PATH = '/callback';
const REQUEST_TIMEOUT_MS = 30_000;
/** A token response that reports no lifetime is treated as one that does not expire (GitHub OAuth apps). */
const NO_EXPIRY = Number.MAX_SAFE_INTEGER;
const STATE_MESSAGE = 'The sign-in response did not match this request. Nothing was connected.';
const DENIED_MESSAGE = 'The sign-in was refused or cancelled. Nothing was connected.';
const CALLBACK_MESSAGE = 'The sign-in response was incomplete. Nothing was connected.';
const OPEN_MESSAGE = 'The browser could not be opened for sign-in. Nothing was connected.';
const EXCHANGE_MESSAGE = 'The sign-in could not be completed. Nothing was connected.';
const UNAVAILABLE_MESSAGE = 'The sign-in service is unavailable or rate limiting requests. Try again later.';
const LISTEN_MESSAGE = 'The local sign-in listener could not start. Nothing was connected.';

export function tokensExpired(tokens: Tokens, now: number): boolean {
  return tokens.expiresAt - EXPIRY_SKEW_MS <= now;
}

export function clockOf(deps: { now?: () => number }): number {
  return deps.now ? deps.now() : Date.now();
}

/** Parses a JSON response body. The error names the provider only, never the body. */
export function parseJsonText(text: string, what: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CloudConnectorError('bad_response', `Could not read the response from ${what}.`);
  }
}

export interface ProviderReply {
  status: number;
  headers: Headers;
  text: string;
}

interface CappedRead {
  bytes: number;
  /** Undefined when the response was longer than the cap. */
  text: string | undefined;
}

async function readCapped(response: Response, max: number): Promise<CappedRead> {
  if (!response.body) return { bytes: 0, text: '' };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > max) {
      await reader.cancel().catch(() => undefined);
      return { bytes, text: undefined };
    }
    chunks.push(value);
  }
  return { bytes, text: Buffer.concat(chunks).toString('utf8') };
}

/**
 * Sends one request to a provider and reads its response up to the cap. The request is recorded, with its path and
 * status, whether or not it succeeded. The URL's query string is never recorded.
 */
export async function callProvider(
  url: string,
  init: RequestInit,
  deps: NetworkDeps,
  what: string,
): Promise<ProviderReply> {
  const target = new URL(url);
  const entry = (status: number, bytes: number): void =>
    deps.record({ host: target.hostname, path: target.pathname, status, bytes, at: clockOf(deps) });
  let response: Response;
  try {
    response = await deps.fetch(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  } catch {
    entry(0, 0);
    throw new CloudConnectorError('network', `Could not reach ${what}.`);
  }
  let read: CappedRead;
  try {
    read = await readCapped(response, MAX_RESPONSE_BYTES);
  } catch {
    entry(response.status, 0);
    throw new CloudConnectorError('network', `Could not reach ${what}.`);
  }
  entry(response.status, read.bytes);
  if (read.text === undefined) {
    throw new CloudConnectorError('too_large', `${capitalise(what)} sent more than 2 MB. Nothing was read.`);
  }
  return { status: response.status, headers: response.headers, text: read.text };
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

export function configuredClientId(provider: ConfiguredProvider): string {
  const clientId = provider.clientId?.trim();
  if (!clientId) throw new CloudConnectorError('not_configured', NOT_CONFIGURED_MESSAGE);
  return clientId;
}

function parseTokens(
  text: string,
  now: number,
  failure: { code: CloudConnectorErrorCode; message: string },
): Tokens {
  const fail = (): CloudConnectorError => new CloudConnectorError(failure.code, failure.message);
  let body: unknown;
  try {
    body = JSON.parse(text) as unknown;
  } catch {
    throw fail();
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) throw fail();
  const fields = body as Record<string, unknown>;
  const accessToken = fields.access_token;
  if (typeof accessToken !== 'string' || accessToken === '') throw fail();
  const refreshToken = typeof fields.refresh_token === 'string' && fields.refresh_token !== '' ? fields.refresh_token : undefined;
  const lifetime = lifetimeSeconds(fields.expires_in);
  const expiresAt = lifetime === undefined ? NO_EXPIRY : now + lifetime * 1000;
  return refreshToken === undefined ? { accessToken, expiresAt } : { accessToken, refreshToken, expiresAt };
}

/** Posts a form to a token endpoint and parses the tokens it returns. A refused request raises `failure`. */
async function requestTokens(
  tokenUrl: string,
  body: URLSearchParams,
  deps: NetworkDeps,
  failure: { code: CloudConnectorErrorCode; message: string },
): Promise<Tokens> {
  const reply = await callProvider(
    tokenUrl,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: body.toString(),
    },
    deps,
    'the sign-in service',
  );
  // A rate limit or an outage says nothing about the account, so it is not reported as an expired sign-in.
  if (reply.status === 429 || reply.status >= 500) throw new CloudConnectorError('unavailable', UNAVAILABLE_MESSAGE);
  if (reply.status < 200 || reply.status > 299) throw new CloudConnectorError(failure.code, failure.message);
  return parseTokens(reply.text, clockOf(deps), failure);
}

/** Gives back a fresh access token. The refresh token is kept when the provider does not send a new one. */
export async function refreshTokens(provider: ConfiguredProvider, refreshToken: string, deps: NetworkDeps): Promise<Tokens> {
  const clientId = configuredClientId(provider);
  if (refreshToken === '') throw new CloudConnectorError('reauth', REAUTH_MESSAGE);
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId });
  const tokens = await requestTokens(provider.tokenUrl, body, deps, { code: 'reauth', message: REAUTH_MESSAGE });
  return { ...tokens, refreshToken: tokens.refreshToken ?? refreshToken };
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** The token lifetime in seconds. A provider may send it as a number or as a numeric string. Anything else is no lifetime. */
function lifetimeSeconds(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0 ? seconds : undefined;
}

function sameSecret(value: string | null, expected: string): boolean {
  if (value === null) return false;
  const given = Buffer.from(value, 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function respond(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', Connection: 'close' });
  response.end(text);
}

interface LoopbackCallback {
  redirectUri: string;
  /** Resolves with the authorization code, or rejects with the reason the flow ended. */
  code: Promise<string>;
  fail(error: Error): void;
  close(): void;
}

function handleCallback(
  request: IncomingMessage,
  response: ServerResponse,
  state: string,
  sink: { resolve(code: string): void; fail(error: Error): void },
): void {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname !== CALLBACK_PATH) {
    respond(response, 404, 'Not found.');
    return;
  }
  if (request.method !== 'GET') {
    respond(response, 405, 'Method not allowed.');
    return;
  }
  if (!sameSecret(url.searchParams.get('state'), state)) {
    respond(response, 400, STATE_MESSAGE);
    sink.fail(new CloudConnectorError('state', STATE_MESSAGE));
    return;
  }
  if (url.searchParams.has('error')) {
    respond(response, 400, DENIED_MESSAGE);
    sink.fail(new CloudConnectorError('denied', DENIED_MESSAGE));
    return;
  }
  const code = url.searchParams.get('code');
  if (!code) {
    respond(response, 400, CALLBACK_MESSAGE);
    sink.fail(new CloudConnectorError('callback', CALLBACK_MESSAGE));
    return;
  }
  // The tokens are saved after this page is sent, so the page does not claim the account is connected.
  respond(response, 200, 'Sign-in received. Return to companyOS to finish. You can close this window.');
  sink.resolve(code);
}

/**
 * Starts the listener on 127.0.0.1 and a free port. The first request that carries the right state completes the sign-in. A
 * request with the wrong state ends the attempt as refused, so another local process can abort it but cannot finish it.
 */
function listenForCallback(state: string, timeoutMs: number): Promise<LoopbackCallback> {
  return new Promise<LoopbackCallback>((resolve, reject) => {
    const server = createServer();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let resolveCode!: (code: string) => void;
    let failCode!: (error: Error) => void;
    const code = new Promise<string>((res, rej) => {
      resolveCode = res;
      failCode = rej;
    });
    // Attached now so that a flow ending before anyone awaits `code` does not leave an unhandled rejection.
    code.catch(() => undefined);
    const close = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      server.close();
      server.closeIdleConnections();
    };
    server.on('request', (request, response) =>
      handleCallback(request, response, state, { resolve: resolveCode, fail: failCode }),
    );
    server.on('error', () => {
      failCode(new CloudConnectorError('callback', LISTEN_MESSAGE));
      reject(new CloudConnectorError('callback', LISTEN_MESSAGE));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      timer = setTimeout(() => failCode(new CloudConnectorError('timeout', TIMEOUT_MESSAGE)), timeoutMs);
      resolve({
        redirectUri: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
        code,
        fail: (error: Error) => failCode(error),
        close,
      });
    });
  });
}

/**
 * Connects one provider. Resolves with the tokens, or rejects with a CloudConnectorError whose message is a fixed sentence.
 * A provider with no client id is refused before anything opens.
 */
export async function startAuthorization(provider: ConfiguredProvider, deps: AuthorizeDeps): Promise<Tokens> {
  const clientId = configuredClientId(provider);
  const verifier = base64url(randomBytes(32));
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = base64url(randomBytes(24));
  const callback = await listenForCallback(state, deps.timeoutMs ?? SIGN_IN_TIMEOUT_MS);
  try {
    const authorization = new URL(provider.authorizationUrl);
    for (const [key, value] of Object.entries(provider.authorizationParams)) authorization.searchParams.set(key, value);
    authorization.searchParams.set('response_type', 'code');
    authorization.searchParams.set('client_id', clientId);
    authorization.searchParams.set('redirect_uri', callback.redirectUri);
    authorization.searchParams.set('scope', provider.scopes.join(' '));
    authorization.searchParams.set('state', state);
    authorization.searchParams.set('code_challenge', challenge);
    authorization.searchParams.set('code_challenge_method', 'S256');
    // A failed open ends the flow at once. A browser that never answers ends it at the timeout.
    void Promise.resolve()
      .then(() => deps.openUrl(authorization.href))
      .catch(() => callback.fail(new CloudConnectorError('open', OPEN_MESSAGE)));
    const code = await callback.code;
    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: callback.redirectUri,
      client_id: clientId,
      code_verifier: verifier,
    });
    return await requestTokens(provider.tokenUrl, body, deps, { code: 'exchange', message: EXCHANGE_MESSAGE });
  } finally {
    callback.close();
  }
}
