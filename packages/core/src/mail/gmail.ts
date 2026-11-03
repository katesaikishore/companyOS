import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { hostAllowed } from '../models/download';
import type { NetworkEntry } from '../models/types';

/**
 * Reads Gmail for the twin, read-only. The sign-in uses the installed-app flow with PKCE, so no client secret is needed.
 * Only message metadata is read: sender, recipients, subject, date, labels and Gmail's short snippet. Message bodies and
 * attachments are never requested. Every call is reported to `record`, with the path shape and never a query, a token or
 * a message id, so the network ledger shows what left the device without showing what was searched for.
 */

/** The hosts a Gmail call may reach. Any other host is refused before a request is made. */
export const GOOGLE_HOSTS: readonly string[] = ['accounts.google.com', 'oauth2.googleapis.com', 'gmail.googleapis.com'];
/** The one permission asked for: read mail, and nothing that changes it. */
export const GMAIL_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly';

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const API = 'https://gmail.googleapis.com/gmail/v1/users/me';
/** The headers read from each message. Nothing else in the message is requested. */
const METADATA_HEADERS = ['From', 'To', 'Subject', 'Date'] as const;

export interface PkcePair {
  verifier: string;
  challenge: string;
}

/** A PKCE pair for one sign-in: a random verifier, and its S256 challenge sent with the sign-in request. */
export function pkcePair(): PkcePair {
  const verifier = randomBytes(48).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

/** The address the person opens to sign in. `state` is checked when the browser comes back. */
export function authorizationUrl(input: { clientId: string; redirectUri: string; challenge: string; state: string }): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: 'code',
    scope: GMAIL_SCOPE,
    code_challenge: input.challenge,
    code_challenge_method: 'S256',
    access_type: 'offline',
    prompt: 'consent',
    state: input.state,
  });
  return `${AUTH_URL}?${params.toString()}`;
}

export interface GoogleTokens {
  accessToken: string;
  refreshToken?: string;
  /** When the access token stops working, in ms since the epoch. */
  expiresAt: number;
}

const TokenResponse = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
});

/** The form posted to the token address, for either the first exchange or a refresh. Never logged. */
export function tokenForm(input: { clientId: string; code: string; verifier: string; redirectUri: string } | { clientId: string; refreshToken: string }): URLSearchParams {
  if ('refreshToken' in input) {
    return new URLSearchParams({ client_id: input.clientId, grant_type: 'refresh_token', refresh_token: input.refreshToken });
  }
  return new URLSearchParams({
    client_id: input.clientId,
    grant_type: 'authorization_code',
    code: input.code,
    code_verifier: input.verifier,
    redirect_uri: input.redirectUri,
  });
}

/** Reads a token reply. Throws without echoing the reply, since it holds secrets. */
export function parseTokens(reply: unknown, now: number, previousRefreshToken?: string): GoogleTokens {
  const parsed = TokenResponse.safeParse(reply);
  if (!parsed.success) throw new Error('Google sent a token reply that is not valid.');
  return {
    accessToken: parsed.data.access_token,
    refreshToken: parsed.data.refresh_token ?? previousRefreshToken,
    expiresAt: now + parsed.data.expires_in * 1000,
  };
}

export interface TokenOptions {
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/**
 * Trades the sign-in code for tokens, or renews the access token from the refresh token. The call goes to the token
 * address only, and it is recorded as a sign-in call with no query and no body in the ledger.
 */
export async function requestTokens(
  input: Parameters<typeof tokenForm>[0],
  options: TokenOptions,
): Promise<GoogleTokens> {
  const target = new URL(TOKEN_URL);
  if (target.protocol !== 'https:' || !hostAllowed(target.hostname, GOOGLE_HOSTS)) {
    throw new GmailError('The address is not one Gmail may use.', undefined);
  }
  const now = options.now ?? Date.now;
  const fetchImpl = options.fetchImpl ?? fetch;
  const ts = now();
  const previous = 'refreshToken' in input ? input.refreshToken : undefined;
  let response: Response;
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: tokenForm(input).toString(),
    });
  } catch {
    options.record({ ts, purpose: 'sign_in', host: 'oauth2.googleapis.com', path: '/token', bytes: 0, outcome: 'failed' });
    throw new GmailError('Google could not be reached.', undefined);
  }
  const text = await response.text();
  options.record({
    ts,
    purpose: 'sign_in',
    host: 'oauth2.googleapis.com',
    path: '/token',
    bytes: Buffer.byteLength(text),
    outcome: response.ok ? 'ok' : 'failed',
  });
  if (!response.ok) throw new GmailError(`Google refused the sign-in with status ${response.status}.`, response.status);
  return parseTokens(readJson(text), now(), previous);
}

function readJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new GmailError('Google sent a reply that is not valid.', undefined);
  }
}

/** Reads a Gmail reply against its schema. The error never echoes the reply, since a reply can hold mail text. */
function readReply<T extends z.ZodType>(schema: T, reply: unknown): z.infer<T> {
  const parsed = schema.safeParse(reply);
  if (!parsed.success) throw new GmailError('Gmail sent a reply that is not valid.', undefined);
  return parsed.data;
}

/** A failed Gmail call. The message names the status, never the reply body, since a body can hold mail text. */
export class GmailError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
  ) {
    super(message);
    this.name = 'GmailError';
  }
}

/** The part of a message the twin keeps. */
export interface MailSummary {
  id: string;
  threadId: string;
  from: string;
  to: string;
  subject: string;
  /** When the message was received, in ms since the epoch, or undefined when Gmail gave no date. */
  receivedAt?: number;
  labels: string[];
  /** Gmail's short preview. Never the whole body. */
  snippet: string;
}

const MessageList = z.object({ messages: z.array(z.object({ id: z.string().min(1) })).optional() });
const Message = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  labelIds: z.array(z.string()).optional(),
  snippet: z.string().optional(),
  internalDate: z.string().optional(),
  payload: z
    .object({ headers: z.array(z.object({ name: z.string(), value: z.string() })).optional() })
    .optional(),
});

export interface GmailClientOptions {
  accessToken: string;
  /** Every call is reported here. The desktop app passes the ledger's recorder. */
  record: (entry: NetworkEntry) => void;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export class GmailClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(private readonly options: GmailClientOptions) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
  }

  /** The ids of up to `max` messages matching a Gmail search, such as "newer_than:7d". The query is sent, never logged. */
  async listMessageIds(query: string, max: number): Promise<string[]> {
    const url = `${API}/messages?${new URLSearchParams({ q: query, maxResults: String(max) }).toString()}`;
    const reply = await this.get(url, '/gmail/v1/users/me/messages');
    return readReply(MessageList, reply).messages?.map(message => message.id) ?? [];
  }

  /** The metadata of one message: who, to whom, the subject, the date, the labels and the snippet. No body. */
  async summary(id: string): Promise<MailSummary> {
    const headers = METADATA_HEADERS.map(name => `metadataHeaders=${name}`).join('&');
    const url = `${API}/messages/${encodeURIComponent(id)}?format=metadata&${headers}`;
    const message = readReply(Message, await this.get(url, '/gmail/v1/users/me/messages/{id}'));
    const header = (name: string): string =>
      message.payload?.headers?.find(entry => entry.name.toLowerCase() === name.toLowerCase())?.value ?? '';
    const received = message.internalDate ? Number(message.internalDate) : NaN;
    return {
      id: message.id,
      threadId: message.threadId,
      from: header('From'),
      to: header('To'),
      subject: header('Subject'),
      ...(Number.isFinite(received) ? { receivedAt: received } : {}),
      labels: message.labelIds ?? [],
      snippet: message.snippet ?? '',
    };
  }

  private async get(url: string, pathShape: string): Promise<unknown> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !hostAllowed(target.hostname, GOOGLE_HOSTS)) {
      throw new GmailError('The address is not one Gmail may use.', undefined);
    }
    const ts = this.now();
    let response: Response;
    try {
      response = await this.fetchImpl(url, { headers: { Authorization: `Bearer ${this.options.accessToken}` } });
    } catch {
      this.report(ts, pathShape, 0, 'failed');
      throw new GmailError('Gmail could not be reached.', undefined);
    }
    const text = await response.text();
    if (!response.ok) {
      this.report(ts, pathShape, Buffer.byteLength(text), 'failed');
      throw new GmailError(`Gmail answered with status ${response.status}.`, response.status);
    }
    this.report(ts, pathShape, Buffer.byteLength(text), 'ok');
    return JSON.parse(text) as unknown;
  }

  private report(ts: number, path: string, bytes: number, outcome: NetworkEntry['outcome']): void {
    this.options.record({ ts, purpose: 'mail_sync', host: 'gmail.googleapis.com', path, bytes, outcome });
  }
}
