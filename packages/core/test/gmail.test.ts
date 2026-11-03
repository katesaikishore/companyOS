import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { NetworkEntry } from '../src/models/types';
import {
  GMAIL_SCOPE,
  GmailClient,
  GmailError,
  authorizationUrl,
  parseTokens,
  pkcePair,
  requestTokens,
  tokenForm,
} from '../src/mail/gmail';

interface Call {
  url: string;
  init?: RequestInit;
}

/** A fetch that answers with fixed replies, and records every address it was asked for. */
function fakeFetch(replies: { status?: number; body: string }[]) {
  const calls: Call[] = [];
  const impl = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const reply = replies[Math.min(calls.length - 1, replies.length - 1)];
    return new Response(reply.body, { status: reply.status ?? 200 });
  }) as typeof fetch;
  return { impl, calls };
}

function ledger() {
  const entries: NetworkEntry[] = [];
  return { entries, record: (entry: NetworkEntry) => entries.push(entry) };
}

describe('pkcePair', () => {
  it('gives an S256 challenge of the verifier, and a new pair each time', () => {
    const pair = pkcePair();
    expect(pair.verifier.length).toBeGreaterThanOrEqual(43);
    expect(pair.challenge).toBe(createHash('sha256').update(pair.verifier).digest('base64url'));
    expect(pkcePair().verifier).not.toBe(pair.verifier);
  });
});

describe('authorizationUrl', () => {
  it('asks Google for read-only mail with PKCE and offline access', () => {
    const url = new URL(authorizationUrl({ clientId: 'client-1', redirectUri: 'http://127.0.0.1:53000/callback', challenge: 'abc', state: 'xyz' }));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('client_id')).toBe('client-1');
    expect(url.searchParams.get('redirect_uri')).toBe('http://127.0.0.1:53000/callback');
    expect(url.searchParams.get('scope')).toBe(GMAIL_SCOPE);
    expect(GMAIL_SCOPE).toBe('https://www.googleapis.com/auth/gmail.readonly');
    expect(url.searchParams.get('code_challenge')).toBe('abc');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('state')).toBe('xyz');
  });
});

describe('tokenForm and parseTokens', () => {
  it('builds the first exchange and the refresh as different forms', () => {
    const exchange = tokenForm({ clientId: 'c', code: 'code-1', verifier: 'v', redirectUri: 'http://127.0.0.1/cb' });
    expect(exchange.get('grant_type')).toBe('authorization_code');
    expect(exchange.get('code_verifier')).toBe('v');
    const refresh = tokenForm({ clientId: 'c', refreshToken: 'r-1' });
    expect(refresh.get('grant_type')).toBe('refresh_token');
    expect(refresh.has('code')).toBe(false);
  });

  it('sets the expiry from the lifetime, and keeps the old refresh token when none is sent', () => {
    const tokens = parseTokens({ access_token: 'a', expires_in: 3600 }, 1_000, 'old-refresh');
    expect(tokens).toEqual({ accessToken: 'a', refreshToken: 'old-refresh', expiresAt: 1_000 + 3_600_000 });
  });

  it('refuses a reply without an access token, without echoing the reply', () => {
    expect(() => parseTokens({ expires_in: 60, leaked: 'secret-value' }, 0)).toThrow('Google sent a token reply that is not valid.');
  });
});

describe('requestTokens', () => {
  it('posts the form to the token address and records the call without its body', async () => {
    const { impl, calls } = fakeFetch([{ body: JSON.stringify({ access_token: 'a', expires_in: 60, refresh_token: 'r' }) }]);
    const log = ledger();
    const tokens = await requestTokens(
      { clientId: 'c', code: 'code-secret', verifier: 'verifier-secret', redirectUri: 'http://127.0.0.1/cb' },
      { record: log.record, fetchImpl: impl, now: () => 5_000 },
    );
    expect(tokens.refreshToken).toBe('r');
    expect(calls[0].url).toBe('https://oauth2.googleapis.com/token');
    expect(String(calls[0].init?.body)).toContain('code_verifier=verifier-secret');
    expect(log.entries).toEqual([
      { ts: 5_000, purpose: 'sign_in', host: 'oauth2.googleapis.com', path: '/token', bytes: expect.any(Number), outcome: 'ok' },
    ]);
    expect(JSON.stringify(log.entries)).not.toContain('secret');
  });

  it('refuses a refused sign-in without echoing the reply, and records it as failed', async () => {
    const { impl } = fakeFetch([{ status: 400, body: 'invalid_grant: mail-body-text' }]);
    const log = ledger();
    const attempt = requestTokens({ clientId: 'c', refreshToken: 'r' }, { record: log.record, fetchImpl: impl });
    await expect(attempt).rejects.toMatchObject({ status: 400 });
    await expect(requestTokens({ clientId: 'c', refreshToken: 'r' }, { record: log.record, fetchImpl: impl })).rejects.not.toThrow('mail-body-text');
    expect(log.entries.map(entry => entry.outcome)).toEqual(['failed', 'failed']);
  });
});

describe('GmailClient', () => {
  it('lists message ids for a search, and records the call with no query', async () => {
    const { impl, calls } = fakeFetch([{ body: JSON.stringify({ messages: [{ id: 'm1' }, { id: 'm2' }] }) }]);
    const log = ledger();
    const client = new GmailClient({ accessToken: 'token-1', record: log.record, fetchImpl: impl, now: () => 9 });
    expect(await client.listMessageIds('newer_than:7d', 20)).toEqual(['m1', 'm2']);
    const url = new URL(calls[0].url);
    expect(url.hostname).toBe('gmail.googleapis.com');
    expect(url.searchParams.get('q')).toBe('newer_than:7d');
    expect(url.searchParams.get('maxResults')).toBe('20');
    expect(new Headers(calls[0].init?.headers).get('Authorization')).toBe('Bearer token-1');
    expect(log.entries).toEqual([
      { ts: 9, purpose: 'mail_sync', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages', bytes: expect.any(Number), outcome: 'ok' },
    ]);
  });

  it('reads message metadata only, and records the path shape without the message id', async () => {
    const reply = {
      id: 'm1',
      threadId: 't1',
      labelIds: ['INBOX'],
      snippet: 'Quarterly numbers attached',
      internalDate: '1700000000000',
      payload: {
        headers: [
          { name: 'from', value: 'Ana <ana@example.com>' },
          { name: 'To', value: 'me@example.com' },
          { name: 'SUBJECT', value: 'Q3 numbers' },
          { name: 'Date', value: 'Tue, 14 Nov 2023' },
        ],
      },
    };
    const { impl, calls } = fakeFetch([{ body: JSON.stringify(reply) }]);
    const log = ledger();
    const summary = await new GmailClient({ accessToken: 't', record: log.record, fetchImpl: impl }).summary('m1');
    expect(summary).toEqual({
      id: 'm1',
      threadId: 't1',
      from: 'Ana <ana@example.com>',
      to: 'me@example.com',
      subject: 'Q3 numbers',
      receivedAt: 1700000000000,
      labels: ['INBOX'],
      snippet: 'Quarterly numbers attached',
    });
    const url = new URL(calls[0].url);
    expect(url.searchParams.get('format')).toBe('metadata');
    expect(url.searchParams.getAll('metadataHeaders')).toEqual(['From', 'To', 'Subject', 'Date']);
    expect(log.entries[0].path).toBe('/gmail/v1/users/me/messages/{id}');
    expect(JSON.stringify(log.entries)).not.toContain('m1');
  });

  it('refuses a status error without echoing the reply, and records it as failed', async () => {
    const { impl } = fakeFetch([{ status: 403, body: 'quota text with a subject line' }]);
    const log = ledger();
    const attempt = new GmailClient({ accessToken: 't', record: log.record, fetchImpl: impl }).listMessageIds('x', 5);
    await expect(attempt).rejects.toBeInstanceOf(GmailError);
    await expect(attempt).rejects.toMatchObject({ status: 403 });
    expect(log.entries[0].outcome).toBe('failed');
  });

  it('refuses a reply that does not match the schema, without echoing it', async () => {
    const { impl } = fakeFetch([{ body: JSON.stringify({ id: 42, leaked: 'private-subject' }) }]);
    const attempt = new GmailClient({ accessToken: 't', record: () => undefined, fetchImpl: impl }).summary('m1');
    await expect(attempt).rejects.toThrow('Gmail sent a reply that is not valid.');
    await expect(attempt).rejects.not.toThrow('private-subject');
  });

  it('records a call that could not reach Google as failed, with no detail', async () => {
    const failing = (async () => {
      throw new TypeError('socket hang up at a private address');
    }) as typeof fetch;
    const log = ledger();
    const attempt = new GmailClient({ accessToken: 't', record: log.record, fetchImpl: failing }).listMessageIds('x', 5);
    await expect(attempt).rejects.toThrow('Gmail could not be reached.');
    expect(log.entries).toEqual([
      { ts: expect.any(Number), purpose: 'mail_sync', host: 'gmail.googleapis.com', path: '/gmail/v1/users/me/messages', bytes: 0, outcome: 'failed' },
    ]);
  });
});
