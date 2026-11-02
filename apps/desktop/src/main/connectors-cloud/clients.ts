/**
 * Read-only clients for the cloud connectors. Each one reads only the window or the assignment the person chose, and
 * returns items for the ingest path. Items pass through redaction there, not here.
 */
import type { ConnectorItem } from '@companyos/twin-core';
import {
  CloudConnectorError,
  REAUTH_MESSAGE,
  callProvider,
  clockOf,
  parseJsonText,
  refreshTokens,
  tokensExpired,
  type NetworkDeps,
  type ProviderReply,
  type Tokens,
} from './oauth';
import type { ConfiguredProvider } from './providers';

/** A time window in epoch milliseconds. `to` is exclusive. */
export interface ReadWindow {
  from: number;
  to: number;
}

export interface ClientDeps extends NetworkDeps {
  /** The configured provider. Its client id is needed to refresh a token. */
  provider: ConfiguredProvider;
  /** Called with the new tokens after each refresh, so the caller can seal and store them. Without it a refresh is lost. */
  saveTokens?(tokens: Tokens): void | Promise<void>;
  /** Waits before the one retry on 429 or 503. Defaults to a real timer. */
  sleep?(ms: number): Promise<void>;
  /** Stops pagination after this many pages. Defaults per provider. */
  maxPages?: number;
}

interface Session {
  tokens: Tokens;
}

const GOOGLE_PAGE_SIZE = 100;
const GOOGLE_MAX_PAGES = 20;
const GITHUB_PAGE_SIZE = 50;
const GITHUB_MAX_PAGES = 10;
const MAX_ITEM_TEXT_CHARS = 4000;
const MAX_TITLE_CHARS = 300;
const DEFAULT_RETRY_MS = 1000;
const MAX_RETRY_WAIT_MS = 60_000;
const GOOGLE_HEADERS: Record<string, string> = { Accept: 'application/json' };
const GITHUB_HEADERS: Record<string, string> = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'companyOS',
};

function requireProvider(provider: ConfiguredProvider, id: ConfiguredProvider['id']): void {
  if (provider.id !== id) throw new CloudConnectorError('provider', 'This read does not match the connector.');
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function listOf(value: unknown): unknown[] {
  return Array.isArray(value) ? (value as unknown[]) : [];
}

function clip(text: string, max: number): string {
  return text.length > max ? text.slice(0, max) : text;
}

/** Wait before the one retry: Retry-After in seconds or as a date, else a short default. Undefined when the wait is too long to hold. */
function retryWaitMs(header: string | null, now: number): number | undefined {
  let wait = DEFAULT_RETRY_MS;
  const value = header === null ? '' : header.trim();
  if (value !== '') {
    const seconds = Number(value);
    if (Number.isFinite(seconds)) {
      wait = Math.max(0, seconds * 1000);
    } else {
      const date = Date.parse(value);
      if (!Number.isNaN(date)) wait = Math.max(0, date - now);
    }
  }
  return wait > MAX_RETRY_WAIT_MS ? undefined : wait;
}

function sleepFor(deps: ClientDeps, ms: number): Promise<void> {
  return deps.sleep ? deps.sleep(ms) : new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function refreshSession(session: Session, deps: ClientDeps): Promise<void> {
  const refreshToken = session.tokens.refreshToken;
  if (!refreshToken) throw new CloudConnectorError('reauth', REAUTH_MESSAGE);
  session.tokens = await refreshTokens(deps.provider, refreshToken, deps);
  await deps.saveTokens?.(session.tokens);
}

/**
 * One authorized GET. An expired token is refreshed first. A 401 causes one refresh and one retry. A 429 or 503 causes one
 * wait, honouring Retry-After, and one retry. Every other failure is raised with a fixed sentence.
 */
async function getWithAuth(
  session: Session,
  url: string,
  headers: Record<string, string>,
  what: string,
  deps: ClientDeps,
): Promise<ProviderReply> {
  if (tokensExpired(session.tokens, clockOf(deps))) await refreshSession(session, deps);
  let refreshed = false;
  let waited = false;
  for (;;) {
    const reply = await callProvider(
      url,
      { method: 'GET', headers: { ...headers, Authorization: `Bearer ${session.tokens.accessToken}` } },
      deps,
      what,
    );
    if (reply.status === 401) {
      if (refreshed) throw new CloudConnectorError('reauth', `${what} rejected the sign-in. Connect the account again.`);
      refreshed = true;
      await refreshSession(session, deps);
      continue;
    }
    if (reply.status === 429 || reply.status === 503) {
      const wait = retryWaitMs(reply.headers.get('retry-after'), clockOf(deps));
      if (waited || wait === undefined) {
        throw new CloudConnectorError('rate_limited', `${what} is rate limiting requests. Try again later.`);
      }
      waited = true;
      await sleepFor(deps, wait);
      continue;
    }
    if (reply.status < 200 || reply.status > 299) {
      throw new CloudConnectorError('api', `${what} request failed with status ${reply.status}.`);
    }
    return reply;
  }
}

/** One Google event as an item. Cancelled and undated events are skipped. The text is the summary, description and location. */
function googleItem(raw: unknown): ConnectorItem | undefined {
  const event = asRecord(raw);
  if (!event) return undefined;
  const id = textOf(event.id);
  if (id === '' || textOf(event.status) === 'cancelled') return undefined;
  const start = asRecord(event.start);
  const ts = Date.parse(textOf(start?.dateTime) || textOf(start?.date));
  if (Number.isNaN(ts)) return undefined;
  const summary = textOf(event.summary);
  const text = [summary, textOf(event.description), textOf(event.location)].filter((part) => part !== '').join('\n');
  return {
    source: 'calendar',
    sourceId: id,
    ts,
    title: clip(summary || 'Untitled event', MAX_TITLE_CHARS),
    text: clip(text, MAX_ITEM_TEXT_CHARS),
  };
}

/**
 * Reads the events on the primary calendar that fall in the window, with recurring events expanded to single instances.
 * Pagination stops at the page cap. Each request is recorded.
 */
export async function fetchGoogleEvents(window: ReadWindow, tokens: Tokens, deps: ClientDeps): Promise<ConnectorItem[]> {
  requireProvider(deps.provider, 'googleCalendar');
  const start = new Date(window.from);
  const end = new Date(window.to);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) {
    throw new CloudConnectorError('window', 'The calendar window is not valid.');
  }
  const session: Session = { tokens };
  const maxPages = deps.maxPages ?? GOOGLE_MAX_PAGES;
  const items: ConnectorItem[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(`${deps.provider.apiBase}/calendars/primary/events`);
    url.searchParams.set('singleEvents', 'true');
    url.searchParams.set('orderBy', 'startTime');
    url.searchParams.set('timeMin', start.toISOString());
    url.searchParams.set('timeMax', end.toISOString());
    url.searchParams.set('maxResults', String(GOOGLE_PAGE_SIZE));
    if (pageToken !== undefined) url.searchParams.set('pageToken', pageToken);
    const reply = await getWithAuth(session, url.href, GOOGLE_HEADERS, 'Google Calendar', deps);
    const body = asRecord(parseJsonText(reply.text, 'Google Calendar'));
    for (const raw of listOf(body?.items)) {
      const item = googleItem(raw);
      if (item) items.push(item);
    }
    pageToken = textOf(body?.nextPageToken) || undefined;
    if (pageToken === undefined) break;
  }
  return items;
}

/**
 * The next page from a Link header, followed only when it stays on the provider's own origin. The token is never sent
 * to another host.
 */
function nextPageUrl(link: string | null, origin: string): string | undefined {
  if (link === null) return undefined;
  for (const match of link.matchAll(/<([^>]+)>([^<]*)/g)) {
    if (!/rel\s*=\s*"?next"?/.test(match[2] ?? '')) continue;
    try {
      const target = new URL(match[1] ?? '');
      return target.origin === origin ? target.href : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** One GitHub issue as an item. Pull requests are skipped, since this endpoint returns them too. The body is not read into the text. */
function githubItem(raw: unknown): ConnectorItem | undefined {
  const issue = asRecord(raw);
  if (!issue || (issue.pull_request !== undefined && issue.pull_request !== null)) return undefined;
  const id = typeof issue.id === 'number' || typeof issue.id === 'string' ? String(issue.id) : '';
  const ts = Date.parse(textOf(issue.updated_at));
  if (id === '' || Number.isNaN(ts)) return undefined;
  const title = textOf(issue.title);
  const repository = textOf(asRecord(issue.repository)?.full_name);
  const labels = listOf(issue.labels)
    .map((label) => (typeof label === 'string' ? label.trim() : textOf(asRecord(label)?.name)))
    .filter((name) => name !== '');
  const text = [title, repository, labels.join(', ')].filter((part) => part !== '').join('\n');
  return {
    source: 'issue',
    sourceId: id,
    ts,
    title: clip(title || 'Untitled issue', MAX_TITLE_CHARS),
    text: clip(text, MAX_ITEM_TEXT_CHARS),
  };
}

/** Reads the open issues assigned to the person, across pages. Pull requests are not included. */
export async function fetchGitHubIssues(tokens: Tokens, deps: ClientDeps): Promise<ConnectorItem[]> {
  requireProvider(deps.provider, 'github');
  const origin = new URL(deps.provider.apiBase).origin;
  const session: Session = { tokens };
  const maxPages = deps.maxPages ?? GITHUB_MAX_PAGES;
  const items: ConnectorItem[] = [];
  let next: string | undefined =
    `${deps.provider.apiBase}/issues?filter=assigned&state=open&per_page=${GITHUB_PAGE_SIZE}`;
  for (let page = 0; next !== undefined && page < maxPages; page += 1) {
    const reply = await getWithAuth(session, next, GITHUB_HEADERS, 'GitHub', deps);
    for (const raw of listOf(parseJsonText(reply.text, 'GitHub'))) {
      const item = githubItem(raw);
      if (item) items.push(item);
    }
    next = nextPageUrl(reply.headers.get('link'), origin);
  }
  return items;
}
