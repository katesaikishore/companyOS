import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchGitHubIssues, fetchGoogleEvents, type ClientDeps, type ReadWindow } from '../../src/main/connectors-cloud/clients';
import { CloudConnectorError, MAX_RESPONSE_BYTES, type NetworkEntry, type Tokens } from '../../src/main/connectors-cloud/oauth';
import type { ConfiguredProvider } from '../../src/main/connectors-cloud/providers';
import { startFakeProvider, testProvider, type FakeProvider } from './fake-provider';

const NOW = Date.UTC(2026, 10, 2, 9, 0);
const WINDOW: ReadWindow = { from: Date.UTC(2026, 10, 2, 0, 0), to: Date.UTC(2026, 10, 3, 0, 0) };
const FRESH: Tokens = { accessToken: 'ACCESS-OK', refreshToken: 'REFRESH-OK', expiresAt: NOW + 3600_000 };
const EVENTS = '/calendar/v3/calendars/primary/events';

const PAGE_ONE = {
  items: [
    {
      id: 'e1',
      summary: 'Standup',
      description: 'Daily sync',
      location: 'Room 4',
      start: { dateTime: '2026-11-02T09:00:00Z' },
    },
    { id: 'e2', summary: 'Dropped', status: 'cancelled', start: { dateTime: '2026-11-02T10:00:00Z' } },
  ],
  nextPageToken: 'PAGE-2',
};
const PAGE_TWO = { items: [{ id: 'e3', summary: 'Review', start: { date: '2026-11-02' } }] };

const ISSUES_PAGE_ONE = [
  {
    id: 101,
    title: 'Fix login',
    updated_at: '2026-11-01T12:00:00Z',
    body: 'BODYCANARY private details that must not be stored',
    repository: { full_name: 'acme/web' },
    labels: [{ name: 'bug' }, { name: 'p1' }],
  },
  {
    id: 102,
    title: 'A pull request',
    updated_at: '2026-11-01T13:00:00Z',
    pull_request: { url: 'https://api.github.com/repos/acme/web/pulls/9' },
    repository: { full_name: 'acme/web' },
    labels: [],
  },
];
const ISSUES_PAGE_TWO = [
  { id: 103, title: 'Update docs', updated_at: '2026-11-01T14:00:00Z', repository: { full_name: 'acme/docs' }, labels: [] },
];

let server: FakeProvider | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

function depsFor(config: ConfiguredProvider, entries: NetworkEntry[], extra: Partial<ClientDeps> = {}): ClientDeps {
  return { provider: config, fetch, record: (entry) => entries.push(entry), now: () => NOW, ...extra };
}

describe('fetchGoogleEvents', () => {
  it('reads both pages of the primary calendar for the window and returns the events', async () => {
    server = await startFakeProvider((request) => {
      if (request.path !== EVENTS) return { status: 404 };
      if (request.headers.authorization !== 'Bearer ACCESS-OK') return { status: 401 };
      return { json: request.search.get('pageToken') === 'PAGE-2' ? PAGE_TWO : PAGE_ONE };
    });
    const entries: NetworkEntry[] = [];

    const items = await fetchGoogleEvents(WINDOW, FRESH, depsFor(testProvider('googleCalendar', server.origin), entries));

    expect(server.requests).toHaveLength(2);
    const [first, second] = server.requests;
    expect(first?.search.get('singleEvents')).toBe('true');
    expect(first?.search.get('timeMin')).toBe(new Date(WINDOW.from).toISOString());
    expect(first?.search.get('timeMax')).toBe(new Date(WINDOW.to).toISOString());
    expect(first?.search.has('pageToken')).toBe(false);
    expect(second?.search.get('pageToken')).toBe('PAGE-2');
    expect(items).toEqual([
      {
        source: 'calendar',
        sourceId: 'e1',
        ts: Date.parse('2026-11-02T09:00:00Z'),
        title: 'Standup',
        text: 'Standup\nDaily sync\nRoom 4',
      },
      { source: 'calendar', sourceId: 'e3', ts: Date.UTC(2026, 10, 2), title: 'Review', text: 'Review' },
    ]);
  });

  it('refreshes a token that has expired before the first request, and hands the new tokens to saveTokens', async () => {
    const expired: Tokens = { accessToken: 'ACCESS-OLD', refreshToken: 'REFRESH-OK', expiresAt: NOW - 1000 };
    server = await startFakeProvider((request) => {
      if (request.path === '/token') {
        const valid = request.form.get('grant_type') === 'refresh_token' && request.form.get('refresh_token') === 'REFRESH-OK';
        return valid ? { json: { access_token: 'ACCESS-NEW', expires_in: 3600 } } : { status: 400, json: {} };
      }
      if (request.path === EVENTS) return request.headers.authorization === 'Bearer ACCESS-NEW' ? { json: PAGE_TWO } : { status: 401 };
      return { status: 404 };
    });
    const saved: Tokens[] = [];

    await fetchGoogleEvents(
      WINDOW,
      expired,
      depsFor(testProvider('googleCalendar', server.origin), [], { saveTokens: (tokens) => void saved.push(tokens) }),
    );

    expect(server.requests.map((request) => request.path)).toEqual(['/token', EVENTS]);
    expect(server.requests[0]?.form.get('client_id')).toBe('test-client-id');
    expect(saved).toEqual([{ accessToken: 'ACCESS-NEW', refreshToken: 'REFRESH-OK', expiresAt: NOW + 3600_000 }]);
  });

  it('causes exactly one refresh and one retry when the provider answers 401', async () => {
    server = await startFakeProvider((request) => {
      if (request.path === '/token') return { json: { access_token: 'ACCESS-NEW', expires_in: 3600 } };
      if (request.path !== EVENTS) return { status: 404 };
      return request.headers.authorization === 'Bearer ACCESS-NEW' ? { json: PAGE_TWO } : { status: 401 };
    });
    const saved: Tokens[] = [];
    const old: Tokens = { accessToken: 'ACCESS-OLD', refreshToken: 'REFRESH-OK', expiresAt: NOW + 3600_000 };

    const items = await fetchGoogleEvents(
      WINDOW,
      old,
      depsFor(testProvider('googleCalendar', server.origin), [], { saveTokens: (tokens) => void saved.push(tokens) }),
    );

    expect(server.requests.map((request) => request.path)).toEqual([EVENTS, '/token', EVENTS]);
    expect(items.map((item) => item.sourceId)).toEqual(['e3']);
    expect(saved).toHaveLength(1);
  });

  it('gives up with a fixed sentence when the retry after a refresh is also refused', async () => {
    server = await startFakeProvider((request) => {
      if (request.path === '/token') return { json: { access_token: 'ACCESS-NEW', expires_in: 3600 } };
      return { status: 401 };
    });

    const error: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), []),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'reauth' });
    expect(server.requests.map((request) => request.path)).toEqual([EVENTS, '/token', EVENTS]);
  });

  it('honours a 429 Retry-After once, then retries', async () => {
    let eventCalls = 0;
    server = await startFakeProvider((request) => {
      if (request.path !== EVENTS) return { status: 404 };
      eventCalls += 1;
      return eventCalls === 1 ? { status: 429, headers: { 'Retry-After': '2' }, text: 'slow down' } : { json: PAGE_TWO };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);

    const items = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), [], { sleep }),
    );

    expect(items.map((item) => item.sourceId)).toEqual(['e3']);
    expect(server.requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  it('honours a 503 Retry-After given as an HTTP date', async () => {
    let eventCalls = 0;
    server = await startFakeProvider(() => {
      eventCalls += 1;
      return eventCalls === 1
        ? { status: 503, headers: { 'Retry-After': new Date(NOW + 5000).toUTCString() }, text: 'busy' }
        : { json: PAGE_TWO };
    });
    const sleep = vi.fn(async (_ms: number) => undefined);

    await fetchGoogleEvents(WINDOW, FRESH, depsFor(testProvider('googleCalendar', server.origin), [], { sleep }));

    expect(sleep).toHaveBeenCalledWith(5000);
    expect(server.requests).toHaveLength(2);
  });

  it('does not retry a second 429, and does not wait for a Retry-After longer than a minute', async () => {
    server = await startFakeProvider(() => ({ status: 429, headers: { 'Retry-After': '1' }, text: 'slow' }));
    const sleep = vi.fn(async (_ms: number) => undefined);
    const twice: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), [], { sleep }),
    ).catch((caught: unknown) => caught);
    expect(twice).toMatchObject({ code: 'rate_limited' });
    expect(server.requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledTimes(1);

    await server.close();
    server = await startFakeProvider(() => ({ status: 429, headers: { 'Retry-After': '3600' }, text: 'much later' }));
    const longWait = vi.fn(async (_ms: number) => undefined);
    const refused: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), [], { sleep: longWait }),
    ).catch((caught: unknown) => caught);
    expect(refused).toMatchObject({ code: 'rate_limited' });
    expect(server.requests).toHaveLength(1);
    expect(longWait).not.toHaveBeenCalled();
  });

  it('stops at the page cap even when the provider keeps offering another page', async () => {
    let calls = 0;
    server = await startFakeProvider(() => {
      calls += 1;
      return {
        json: {
          items: [{ id: `e${calls}`, summary: `Event ${calls}`, start: { dateTime: '2026-11-02T09:00:00Z' } }],
          nextPageToken: 'MORE',
        },
      };
    });

    const items = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), [], { maxPages: 3 }),
    );

    expect(server.requests).toHaveLength(3);
    expect(items.map((item) => item.sourceId)).toEqual(['e1', 'e2', 'e3']);
  });

  it('records each request by path only, with no query string and no token', async () => {
    server = await startFakeProvider((request) => {
      if (request.path === '/token') return { json: { access_token: 'ACCESS-NEW', expires_in: 3600 } };
      if (request.path !== EVENTS) return { status: 404 };
      return request.headers.authorization === 'Bearer ACCESS-NEW' ? { json: PAGE_TWO } : { status: 401 };
    });
    const entries: NetworkEntry[] = [];
    const old: Tokens = { accessToken: 'ACCESS-OLD', refreshToken: 'REFRESH-OK', expiresAt: NOW + 3600_000 };

    await fetchGoogleEvents(WINDOW, old, depsFor(testProvider('googleCalendar', server.origin), entries));

    expect(entries.map((entry) => entry.path)).toEqual([EVENTS, '/token', EVENTS]);
    expect(entries.map((entry) => entry.status)).toEqual([401, 200, 200]);
    for (const entry of entries) {
      expect(Object.keys(entry).sort()).toEqual(['at', 'bytes', 'host', 'path', 'status']);
      expect(entry.path).not.toContain('?');
      expect(entry.host).toBe('127.0.0.1');
    }
    const serialized = JSON.stringify(entries);
    for (const secret of ['ACCESS-OLD', 'ACCESS-NEW', 'REFRESH-OK', 'timeMin', 'pageToken', 'singleEvents']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('keeps the token out of an error message when the provider echoes it back', async () => {
    server = await startFakeProvider(() => ({ status: 500, text: 'failed for ACCESS-OK' }));

    const error: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), []),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'api', message: 'Google Calendar request failed with status 500.' });
    expect((error as Error).message).not.toContain('ACCESS-OK');
  });

  it('keeps the refresh token out of an error message when the refresh is refused', async () => {
    const expired: Tokens = { accessToken: 'ACCESS-OLD', refreshToken: 'REFRESH-REVOKED', expiresAt: NOW - 1000 };
    server = await startFakeProvider((request) => ({
      status: 400,
      json: { error: 'invalid_grant', error_description: `refused ${request.form.get('refresh_token')}` },
    }));

    const error: unknown = await fetchGoogleEvents(
      WINDOW,
      expired,
      depsFor(testProvider('googleCalendar', server.origin), []),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'reauth' });
    expect((error as Error).message).not.toContain('REFRESH-REVOKED');
  });

  it('refuses a response larger than the cap before it is parsed', async () => {
    server = await startFakeProvider(() => ({ status: 200, text: 'x'.repeat(MAX_RESPONSE_BYTES + 1) }));
    const entries: NetworkEntry[] = [];

    const error: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), entries),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'too_large' });
    expect(entries[0]?.bytes).toBeGreaterThan(MAX_RESPONSE_BYTES);
  });

  it('records a failed request with status 0 and reports a fixed sentence', async () => {
    const closed = await startFakeProvider(() => ({ json: {} }));
    const origin = closed.origin;
    await closed.close();
    const entries: NetworkEntry[] = [];

    const error: unknown = await fetchGoogleEvents(
      WINDOW,
      FRESH,
      depsFor(testProvider('googleCalendar', origin), entries),
    ).catch((caught: unknown) => caught);

    expect(error).toMatchObject({ code: 'network', message: 'Could not reach Google Calendar.' });
    expect(entries).toEqual([{ host: '127.0.0.1', path: EVENTS, status: 0, bytes: 0, at: NOW }]);
  });

  it('refuses a window that ends before it starts, and a provider from another connector, without a request', async () => {
    server = await startFakeProvider(() => ({ json: {} }));

    const backwards: unknown = await fetchGoogleEvents(
      { from: WINDOW.to, to: WINDOW.from },
      FRESH,
      depsFor(testProvider('googleCalendar', server.origin), []),
    ).catch((caught: unknown) => caught);
    expect(backwards).toMatchObject({ code: 'window' });

    const wrong: unknown = await fetchGoogleEvents(WINDOW, FRESH, depsFor(testProvider('github', server.origin), [])).catch(
      (caught: unknown) => caught,
    );
    expect(wrong).toMatchObject({ code: 'provider' });
    expect(server.requests).toHaveLength(0);
    expect(wrong).toBeInstanceOf(CloudConnectorError);
  });
});

describe('fetchGitHubIssues', () => {
  it('reads assigned open issues across Link pages, leaving out pull requests and bodies', async () => {
    let origin = '';
    server = await startFakeProvider((request) => {
      if (request.path !== '/issues') return { status: 404 };
      if (request.headers.authorization !== 'Bearer ACCESS-OK') return { status: 401 };
      if (request.search.get('page') === '2') return { json: ISSUES_PAGE_TWO };
      return {
        json: ISSUES_PAGE_ONE,
        headers: {
          Link: `<${origin}/issues?filter=assigned&state=open&per_page=50&page=2>; rel="next", <${origin}/issues?filter=assigned&state=open&per_page=50&page=2>; rel="last"`,
        },
      };
    });
    origin = server.origin;

    const items = await fetchGitHubIssues(FRESH, depsFor(testProvider('github', origin), []));

    expect(server.requests.map((request) => request.search.get('page'))).toEqual([null, '2']);
    expect(server.requests[0]?.search.get('filter')).toBe('assigned');
    expect(server.requests[0]?.search.get('state')).toBe('open');
    expect(items).toEqual([
      {
        source: 'issue',
        sourceId: '101',
        ts: Date.parse('2026-11-01T12:00:00Z'),
        title: 'Fix login',
        text: 'Fix login\nacme/web\nbug, p1',
      },
      {
        source: 'issue',
        sourceId: '103',
        ts: Date.parse('2026-11-01T14:00:00Z'),
        title: 'Update docs',
        text: 'Update docs\nacme/docs',
      },
    ]);
    expect(JSON.stringify(items)).not.toContain('BODYCANARY');
  });

  it('does not follow a Link header that points to another host', async () => {
    server = await startFakeProvider(() => ({
      json: [ISSUES_PAGE_TWO[0]],
      headers: { Link: '<https://evil.example/issues?page=2>; rel="next"' },
    }));
    const entries: NetworkEntry[] = [];

    const items = await fetchGitHubIssues(FRESH, depsFor(testProvider('github', server.origin), entries));

    expect(items.map((item) => item.sourceId)).toEqual(['103']);
    expect(server.requests).toHaveLength(1);
    expect(entries.every((entry) => entry.host === '127.0.0.1')).toBe(true);
  });

  it('stops at the page cap even when every page links to another', async () => {
    let calls = 0;
    let origin = '';
    server = await startFakeProvider(() => {
      calls += 1;
      return {
        json: [{ id: 200 + calls, title: `Issue ${calls}`, updated_at: '2026-11-01T12:00:00Z', labels: [] }],
        headers: { Link: `<${origin}/issues?page=${calls + 1}>; rel="next"` },
      };
    });
    origin = server.origin;

    const items = await fetchGitHubIssues(FRESH, depsFor(testProvider('github', origin), [], { maxPages: 3 }));

    expect(server.requests).toHaveLength(3);
    expect(items.map((item) => item.sourceId)).toEqual(['201', '202', '203']);
  });

  it('refreshes once on 401 and keeps the bearer token on the provider origin only', async () => {
    server = await startFakeProvider((request) => {
      if (request.path === '/token') return { json: { access_token: 'ACCESS-NEW', expires_in: 3600 } };
      if (request.path !== '/issues') return { status: 404 };
      return request.headers.authorization === 'Bearer ACCESS-NEW' ? { json: ISSUES_PAGE_TWO } : { status: 401 };
    });
    const old: Tokens = { accessToken: 'ACCESS-OLD', refreshToken: 'REFRESH-OK', expiresAt: NOW + 3600_000 };

    const items = await fetchGitHubIssues(old, depsFor(testProvider('github', server.origin), []));

    expect(server.requests.map((request) => request.path)).toEqual(['/issues', '/token', '/issues']);
    expect(items.map((item) => item.sourceId)).toEqual(['103']);
  });
});
