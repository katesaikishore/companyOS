import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CloudConnectorError,
  NOT_CONFIGURED_MESSAGE,
  TIMEOUT_MESSAGE,
  refreshTokens,
  startAuthorization,
  type NetworkEntry,
} from '../../src/main/connectors-cloud/oauth';
import { configureProvider } from '../../src/main/connectors-cloud/providers';
import { startFakeProvider, testProvider, withParams, type FakeProvider } from './fake-provider';

const NOW = Date.UTC(2026, 10, 2, 9, 0);
const sha256Base64url = (value: string): string => createHash('sha256').update(value).digest('base64url');

let provider: FakeProvider | undefined;

afterEach(async () => {
  await provider?.close();
  provider = undefined;
});

/** Plays the browser: reads the authorization URL, then returns to the loopback listener with the given code and state. */
function browserReturning(
  code: string | undefined,
  stateOverride?: string,
  seen?: { challenge?: string; state?: string; url?: URL },
) {
  return vi.fn(async (url: string) => {
    const authorization = new URL(url);
    if (seen) {
      seen.url = authorization;
      seen.challenge = authorization.searchParams.get('code_challenge') ?? undefined;
      seen.state = authorization.searchParams.get('state') ?? undefined;
    }
    const redirect = authorization.searchParams.get('redirect_uri') ?? '';
    const params: Record<string, string> = { state: stateOverride ?? authorization.searchParams.get('state') ?? '' };
    if (code !== undefined) params.code = code;
    await fetch(withParams(redirect, params));
  });
}

describe('startAuthorization', () => {
  it('sends an S256 challenge that matches the verifier, and exchanges the code with that verifier', async () => {
    const seen: { challenge?: string; state?: string; url?: URL } = {};
    let verifierSeen = '';
    provider = await startFakeProvider((request) => {
      if (request.path !== '/token') return { status: 404 };
      verifierSeen = request.form.get('code_verifier') ?? '';
      const valid =
        request.form.get('grant_type') === 'authorization_code' &&
        request.form.get('code') === 'AUTH-CODE-1' &&
        sha256Base64url(verifierSeen) === seen.challenge;
      if (!valid) return { status: 400, json: { error: 'invalid_grant' } };
      return { json: { access_token: 'ACCESS-1', refresh_token: 'REFRESH-1', expires_in: 3600, token_type: 'bearer' } };
    });
    const entries: NetworkEntry[] = [];
    const openUrl = browserReturning('AUTH-CODE-1', undefined, seen);

    const tokens = await startAuthorization(testProvider('googleCalendar', provider.origin), {
      openUrl,
      fetch,
      record: (entry) => entries.push(entry),
      now: () => NOW,
    });

    expect(tokens).toEqual({ accessToken: 'ACCESS-1', refreshToken: 'REFRESH-1', expiresAt: NOW + 3600_000 });
    expect(verifierSeen.length).toBeGreaterThanOrEqual(43);
    expect(verifierSeen).toMatch(/^[A-Za-z0-9._~-]+$/);
    expect(seen.challenge).toBe(sha256Base64url(verifierSeen));
    expect(seen.url?.searchParams.get('code_challenge_method')).toBe('S256');
    expect(seen.url?.searchParams.get('client_id')).toBe('test-client-id');
    expect(seen.url?.searchParams.get('scope')).toBe('https://www.googleapis.com/auth/calendar.readonly');
    expect(seen.url?.searchParams.get('access_type')).toBe('offline');
    const redirect = new URL(seen.url?.searchParams.get('redirect_uri') ?? '');
    expect(redirect.hostname).toBe('127.0.0.1');
    expect(redirect.pathname).toBe('/callback');

    expect(entries).toEqual([
      { host: '127.0.0.1', path: '/token', status: 200, bytes: expect.any(Number), at: NOW },
    ]);
    expect(entries[0]?.bytes).toBeGreaterThan(0);
  });

  it('refuses a callback whose state does not match, and never exchanges the code', async () => {
    const seen: { state?: string } = {};
    let tokenCalls = 0;
    provider = await startFakeProvider(() => {
      tokenCalls += 1;
      return { json: { access_token: 'ACCESS-1', expires_in: 3600 } };
    });
    const openUrl = vi.fn(async (url: string) => {
      const authorization = new URL(url);
      seen.state = authorization.searchParams.get('state') ?? undefined;
      await fetch(withParams(authorization.searchParams.get('redirect_uri') ?? '', { code: 'AUTH-CODE-1', state: 'FORGED-STATE' }));
    });

    const error: unknown = await startAuthorization(testProvider('github', provider.origin), {
      openUrl,
      fetch,
      record: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(CloudConnectorError);
    expect(error).toMatchObject({ code: 'state' });
    const message = (error as Error).message;
    expect(seen.state).toBeTruthy();
    expect(message).not.toContain('FORGED-STATE');
    expect(message).not.toContain(seen.state as string);
    expect(tokenCalls).toBe(0);
  });

  it('times out with the fixed sentence when the browser never returns', async () => {
    provider = await startFakeProvider(() => ({ json: {} }));
    const error: unknown = await startAuthorization(testProvider('github', provider.origin), {
      openUrl: vi.fn(async () => undefined),
      fetch,
      record: () => undefined,
      timeoutMs: 50,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'timeout', message: TIMEOUT_MESSAGE });
    expect(provider.requests).toHaveLength(0);
  });

  it('reports a refused sign-in with a fixed sentence', async () => {
    provider = await startFakeProvider(() => ({ json: {} }));
    const openUrl = vi.fn(async (url: string) => {
      const authorization = new URL(url);
      await fetch(withParams(authorization.searchParams.get('redirect_uri') ?? '', { error: 'access_denied', state: authorization.searchParams.get('state') ?? '' }));
    });
    const error: unknown = await startAuthorization(testProvider('github', provider.origin), {
      openUrl,
      fetch,
      record: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'denied' });
    expect((error as Error).message).not.toContain('access_denied');
  });

  it('ends the flow at once when the browser cannot be opened, and does not put the URL in the message', async () => {
    provider = await startFakeProvider(() => ({ json: {} }));
    const error: unknown = await startAuthorization(testProvider('github', provider.origin), {
      openUrl: vi.fn(async () => {
        throw new Error('no browser');
      }),
      fetch,
      record: () => undefined,
      timeoutMs: 60_000,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'open' });
    expect((error as Error).message).not.toContain('http');
  });

  it('keeps the code and the verifier out of an exchange error message', async () => {
    let verifierSeen = '';
    provider = await startFakeProvider((request) => {
      verifierSeen = request.form.get('code_verifier') ?? '';
      // A provider that echoes the code and verifier back in its error body.
      return { status: 400, json: { error: 'invalid_grant', error_description: `${request.form.get('code')} ${verifierSeen}` } };
    });
    const error: unknown = await startAuthorization(testProvider('googleCalendar', provider.origin), {
      openUrl: browserReturning('AUTH-CODE-SECRET'),
      fetch,
      record: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'exchange' });
    const message = (error as Error).message;
    expect(verifierSeen.length).toBeGreaterThan(0);
    expect(message).not.toContain('AUTH-CODE-SECRET');
    expect(message).not.toContain(verifierSeen);
  });

  it('refuses to connect a provider with no client id, before anything opens', async () => {
    const openUrl = vi.fn(async () => undefined);
    const fetchSpy = vi.fn();
    for (const clientIds of [{}, { github: '   ' }]) {
      const error: unknown = await startAuthorization(configureProvider('github', clientIds), {
        openUrl,
        fetch: fetchSpy as unknown as typeof fetch,
        record: () => undefined,
      }).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(CloudConnectorError);
      expect(error).toMatchObject({ code: 'not_configured', message: NOT_CONFIGURED_MESSAGE });
    }
    expect(NOT_CONFIGURED_MESSAGE).toBe('This connector is not configured yet, so it cannot connect.');
    expect(openUrl).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('refreshTokens', () => {
  it('keeps the old refresh token when the provider does not send a new one', async () => {
    provider = await startFakeProvider((request) => {
      if (request.form.get('grant_type') !== 'refresh_token') return { status: 400, json: { error: 'unsupported' } };
      return { json: { access_token: 'ACCESS-2', expires_in: 1800 } };
    });
    const entries: NetworkEntry[] = [];
    const tokens = await refreshTokens(testProvider('googleCalendar', provider.origin), 'REFRESH-1', {
      fetch,
      record: (entry) => entries.push(entry),
      now: () => NOW,
    });

    expect(tokens).toEqual({ accessToken: 'ACCESS-2', refreshToken: 'REFRESH-1', expiresAt: NOW + 1800_000 });
    expect(entries.map((entry) => entry.path)).toEqual(['/token']);
  });

  it('reads a lifetime sent as a numeric string, so the token is still refreshed on time', async () => {
    provider = await startFakeProvider(() => ({ json: { access_token: 'ACCESS-3', expires_in: '1800' } }));
    const tokens = await refreshTokens(testProvider('googleCalendar', provider.origin), 'REFRESH-1', {
      fetch,
      record: () => undefined,
      now: () => NOW,
    });

    expect(tokens.expiresAt).toBe(NOW + 1800_000);
  });

  it('reports a provider outage as unavailable rather than as an expired sign-in', async () => {
    provider = await startFakeProvider(() => ({ status: 503, json: { error: 'temporarily_unavailable' } }));
    const error: unknown = await refreshTokens(testProvider('googleCalendar', provider.origin), 'REFRESH-1', {
      fetch,
      record: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'unavailable' });
    expect((error as Error).message).not.toContain('Connect the account again');
  });

  it('asks the person to connect again, with a fixed sentence, when the refresh is refused', async () => {
    provider = await startFakeProvider((request) => ({
      status: 400,
      json: { error: 'invalid_grant', error_description: `refused ${request.form.get('refresh_token')}` },
    }));
    const error: unknown = await refreshTokens(testProvider('googleCalendar', provider.origin), 'REFRESH-REVOKED', {
      fetch,
      record: () => undefined,
    }).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'reauth' });
    expect((error as Error).message).toBe('Your sign-in has expired. Connect the account again.');
    expect((error as Error).message).not.toContain('REFRESH-REVOKED');
  });
});
