/**
 * The cloud connectors in the desktop app: Google Calendar and GitHub. Each is connected through the person's own sign-in in
 * the browser, reads only what its connector needs, and never writes. The tokens are sealed on this device (see
 * connectors-cloud/seal.ts). Reads run on the schedule the local sources use, behind the same pause, lock and idle gates, and
 * every request is written to the network ledger with its host and path, never a query string or a token.
 *
 * One account per provider. Its saved source has a random id, and that same id is the key its items are stored under, because
 * the engine stores items only under the id of a saved source. The key is not 'cloud:<provider>': a saved id needs at least
 * 16 characters, and 'cloud:github' has 12.
 *
 * Every change to the source list, every read and every disconnect runs one at a time, through one queue. A sign-in waits in
 * the browser outside the queue, so it does not hold up the reads of the other account.
 */
import { randomBytes } from 'node:crypto';
import type { CloudAccountView, ConnectorItem, NetworkEntry as LedgerEntry, TwinConfig } from '@companyos/twin-core';
import type { ConnectorStore } from './connectors-runner';
import { CHECK_INTERVAL_MS, SOURCE_FULL_MESSAGE, SOURCE_MISSING_MESSAGE, SOURCE_SAVE_MESSAGE, isImportDue, type ImportGate } from './connectors-scheduler';
import { CONNECTOR_SOURCE_MAX } from './connectors-validate';
import { fetchGitHubIssues, fetchGoogleEvents, type ClientDeps } from './connectors-cloud/clients';
import {
  CloudConnectorError,
  NOT_CONFIGURED_MESSAGE,
  REAUTH_MESSAGE,
  startAuthorization,
  type NetworkEntry as CallEntry,
  type Tokens,
} from './connectors-cloud/oauth';
import {
  CLOUD_PROVIDERS,
  CLOUD_PROVIDER_IDS,
  isCloudProviderId,
  type ClientIds,
  type CloudProvider,
  type CloudProviderId,
  type ConfiguredProvider,
} from './connectors-cloud/providers';
import type { TokenStore } from './connectors-cloud/token-store';

type ConnectorSource = TwinConfig['connectors'][number];
type CloudSourceKind = 'google-calendar' | 'github';

const SOURCE_KIND: Readonly<Record<CloudProviderId, CloudSourceKind>> = {
  googleCalendar: 'google-calendar',
  github: 'github',
};

const DAY_MS = 86_400_000;
/** The calendar window of a read: events from this many days before it to this many days after it. */
const GOOGLE_DAYS_BACK = 30;
const GOOGLE_DAYS_AHEAD = 60;
/** Items are stored in batches, so a large read does not hold the main process for one long write. */
const STORE_BATCH = 200;

const UNKNOWN_ACCOUNT_MESSAGE = 'That account is not known.';
const ALREADY_CONNECTED_MESSAGE = 'This account is already connected. Disconnect it first.';
const SIGN_IN_OPEN_MESSAGE = 'A sign-in for this account is already open. Finish it first.';
const SIGN_IN_ABORTED_MESSAGE = 'The data was deleted while signing in. Nothing was connected.';
const TOKEN_SAVE_MESSAGE = 'The sign-in could not be saved on this device. Nothing was connected.';
const REFRESH_SAVE_MESSAGE = 'A refreshed sign-in could not be saved on this device. Connect the account again.';
const TOKEN_REMOVE_MESSAGE = 'The saved sign-in could not be removed from this device. Choose Disconnect again.';
const READ_FAILED_MESSAGE = 'The account could not be read. Its items were not changed.';
const STORE_FAILED_MESSAGE = 'The items could not be stored. Read the account again.';
const LEDGER_FAILED_MESSAGE = 'A request could not be written to the network ledger.';
const CONNECT_FAILED_SUFFIX = 'Nothing was connected.';

/** The sentences this module may show or log. Anything else an error carries is replaced by READ_FAILED_MESSAGE. */
const KNOWN_MESSAGES: ReadonlySet<string> = new Set([
  UNKNOWN_ACCOUNT_MESSAGE,
  ALREADY_CONNECTED_MESSAGE,
  SIGN_IN_OPEN_MESSAGE,
  SIGN_IN_ABORTED_MESSAGE,
  TOKEN_SAVE_MESSAGE,
  REFRESH_SAVE_MESSAGE,
  TOKEN_REMOVE_MESSAGE,
  READ_FAILED_MESSAGE,
  STORE_FAILED_MESSAGE,
  LEDGER_FAILED_MESSAGE,
  SOURCE_FULL_MESSAGE,
  SOURCE_MISSING_MESSAGE,
  SOURCE_SAVE_MESSAGE,
]);

/** The sentence to show or log for an error. Only a fixed sentence passes through, so no path, token or item text can. */
function fixedMessage(error: unknown): string {
  if (error instanceof CloudConnectorError) return error.message;
  if (error instanceof Error && KNOWN_MESSAGES.has(error.message)) return error.message;
  return READ_FAILED_MESSAGE;
}

/** Checks a value from the page or the menu. Anything but a known account is refused before the runtime sees it. */
function cloudProviderArg(value: unknown): CloudProviderId {
  if (!isCloudProviderId(value)) throw new Error(UNKNOWN_ACCOUNT_MESSAGE);
  return value;
}

function isCloudKind(kind: ConnectorSource['kind']): kind is CloudSourceKind {
  return kind === 'google-calendar' || kind === 'github';
}

function providerOfKind(kind: CloudSourceKind): CloudProviderId {
  return kind === 'google-calendar' ? 'googleCalendar' : 'github';
}

/** The part of the engine this module uses: the connector store, plus the network ledger. */
interface CloudStore extends ConnectorStore {
  recordNetworkCall(entry: LedgerEntry): void;
}

/** The capture gates the scheduled reads wait for. The runtime passes the same gate the local sources use. */
interface CloudConnectorServiceOptions {
  agent: CloudStore;
  tokens: TokenStore;
  now: () => number;
  gate: () => ImportGate;
  clientIds: ClientIds;
  /** The provider endpoints. The app passes the built-in ones. The tests point them at a fake provider. */
  providers?: Readonly<Record<CloudProviderId, CloudProvider>>;
  fetch: typeof fetch;
  /** Opens a provider's sign-in page in the person's browser. The app passes shell.openExternal. */
  openExternal: (url: string) => Promise<void>;
  /** Receives a fixed sentence when a read or a removal fails. It never holds a token, a response or an item's text. */
  report?: (message: string) => void;
  /** How long a sign-in waits for the browser. Defaults to three minutes. */
  signInTimeoutMs?: number;
}

export class CloudConnectorService {
  /** When each account was last read, by source id, whether or not the read worked. In memory, so a restart starts the wait again. */
  private readonly lastAttempt = new Map<string, number>();
  /** The item count of each account's last successful read this session, by source id. Not saved. */
  private readonly counts = new Map<string, number>();
  /** Accounts with a sign-in open in the browser. One at a time for each account. */
  private readonly signingIn = new Set<CloudProviderId>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private checking = false;
  /** Bumped by wipe. A sign-in that started before it is not saved. */
  private generation = 0;

  constructor(private readonly options: CloudConnectorServiceOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops the check and forgets the read times. A stopped service reads nothing on its own. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastAttempt.clear();
  }

  /** Each account's state for Settings. It holds no client id and no token: only whether one is set and whether it is connected. */
  accounts(): CloudAccountView[] {
    return CLOUD_PROVIDER_IDS.map(provider => {
      const source = this.sourceOf(provider);
      const view: CloudAccountView = {
        provider,
        configured: this.configured(provider).clientId !== undefined,
        connected: source !== undefined,
      };
      if (source?.lastImportedAt !== undefined) view.lastImportedAt = source.lastImportedAt;
      const count = source ? this.counts.get(source.id) : undefined;
      if (count !== undefined) view.count = count;
      return view;
    });
  }

  /**
   * One check. It reads each due account, unless capture is paused, the screen is locked or the person is away. The gate is
   * read again before each account. A check that starts while another runs does nothing. It never throws.
   */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.options.now();
      const due = this.cloudSources().filter(source => isImportDue(source, this.lastAttempt.get(source.id), now));
      for (const source of due) {
        const gate = this.options.gate();
        if (gate.paused || gate.locked || gate.idle) return;
        await this.enqueue(() => this.importOne(source.id)).catch(error => this.report(error));
      }
    } finally {
      this.checking = false;
    }
  }

  /**
   * Connects one account. The person signs in in the browser, the tokens are sealed, and the first read runs. Resolves to the
   * items that read stored. A refusal before the browser opens (not configured, already connected, list full) names its reason.
   */
  async connect(provider: CloudProviderId): Promise<number> {
    const id = cloudProviderArg(provider);
    const configured = this.configured(id);
    if (configured.clientId === undefined) throw new CloudConnectorError('not_configured', NOT_CONFIGURED_MESSAGE);
    if (this.signingIn.has(id)) throw new Error(SIGN_IN_OPEN_MESSAGE);
    this.checkRoom(id);
    this.signingIn.add(id);
    const generation = this.generation;
    try {
      const tokens = await startAuthorization(configured, {
        fetch: this.options.fetch,
        record: entry => this.record(entry),
        now: this.options.now,
        openUrl: url => this.options.openExternal(url),
        ...(this.options.signInTimeoutMs === undefined ? {} : { timeoutMs: this.options.signInTimeoutMs }),
      });
      return await this.enqueue(() => this.finishConnect(id, tokens, generation));
    } finally {
      this.signingIn.delete(id);
    }
  }

  /**
   * Disconnects one account. Its tokens go first, so nothing can read with them again, then its items, then its source. A
   * failure leaves the rest in place, and Disconnect can be chosen again.
   */
  disconnect(provider: CloudProviderId): Promise<void> {
    const id = cloudProviderArg(provider);
    return this.enqueue(async () => {
      await this.removeTokens(id);
      const source = this.sourceOf(id);
      if (source) this.forgetSource(source.id);
    });
  }

  /** Deletes every account's tokens and forgets the read times. Delete everything calls it. A sign-in in progress is not saved. */
  wipe(): Promise<void> {
    this.generation += 1;
    return this.enqueue(async () => {
      let failed = false;
      for (const id of CLOUD_PROVIDER_IDS) {
        try {
          await this.removeTokens(id);
        } catch {
          failed = true;
        }
      }
      this.lastAttempt.clear();
      this.counts.clear();
      if (failed) throw new Error(TOKEN_REMOVE_MESSAGE);
    });
  }

  private async finishConnect(provider: CloudProviderId, tokens: Tokens, generation: number): Promise<number> {
    if (generation !== this.generation) throw new Error(SIGN_IN_ABORTED_MESSAGE);
    this.checkRoom(provider);
    await this.saveTokens(provider, tokens, TOKEN_SAVE_MESSAGE);
    const source: ConnectorSource = {
      id: randomBytes(16).toString('hex'),
      kind: SOURCE_KIND[provider],
      label: this.providerOf(provider).displayName,
      createdAt: this.options.now(),
    };
    try {
      this.saveSources([...this.sources(), source]);
    } catch (error) {
      await this.removeTokensQuietly(provider);
      throw error;
    }
    try {
      return await this.importOne(source.id);
    } catch (error) {
      // As with a local source, an account whose first read fails is not kept, so the list holds only accounts that work.
      this.forgetSourceQuietly(source.id);
      await this.removeTokensQuietly(provider);
      throw new Error(`${fixedMessage(error)} ${CONNECT_FAILED_SUFFIX}`);
    }
  }

  /** Reads one account and replaces its items. Throws a fixed sentence when the read fails, and keeps the items it had. */
  private async importOne(sourceId: string): Promise<number> {
    const source = this.cloudSources().find(item => item.id === sourceId);
    if (!source || !isCloudKind(source.kind)) throw new Error(SOURCE_MISSING_MESSAGE);
    this.lastAttempt.set(sourceId, this.options.now());
    const items = await this.read(providerOfKind(source.kind));
    const count = this.storeItems(sourceId, items);
    this.counts.set(sourceId, count);
    return count;
  }

  private async read(provider: CloudProviderId): Promise<ConnectorItem[]> {
    const tokens = await this.options.tokens.load(provider);
    if (tokens === undefined) throw new CloudConnectorError('reauth', REAUTH_MESSAGE);
    const deps: ClientDeps = {
      provider: this.configured(provider),
      fetch: this.options.fetch,
      record: entry => this.record(entry),
      now: this.options.now,
      saveTokens: refreshed => this.saveTokens(provider, refreshed, REFRESH_SAVE_MESSAGE),
    };
    if (provider === 'googleCalendar') {
      const now = this.options.now();
      return fetchGoogleEvents({ from: now - GOOGLE_DAYS_BACK * DAY_MS, to: now + GOOGLE_DAYS_AHEAD * DAY_MS }, tokens, deps);
    }
    return fetchGitHubIssues(tokens, deps);
  }

  /**
   * Replaces the account's items with the ones just read and records the read time. The old items go only once the new ones are
   * in hand. A store failure removes what was stored, so no half set is left behind.
   */
  private storeItems(sourceId: string, items: readonly ConnectorItem[]): number {
    const agent = this.options.agent;
    if (!this.isSaved(sourceId)) throw new Error(SOURCE_MISSING_MESSAGE);
    try {
      agent.removeConnectorItems(sourceId);
      let count = 0;
      for (let start = 0; start < items.length; start += STORE_BATCH) {
        count += agent.ingestConnectorItems(sourceId, items.slice(start, start + STORE_BATCH));
      }
      const now = this.options.now();
      agent.updateConfig({
        connectors: this.sources().map(source => (source.id === sourceId ? { ...source, lastImportedAt: now } : source)),
      });
      return count;
    } catch {
      try {
        agent.removeConnectorItems(sourceId);
      } catch {
        // Nothing more can be done here. The next read replaces the items, and Disconnect removes them.
      }
      throw new Error(STORE_FAILED_MESSAGE);
    }
  }

  /** Removes a source's items, then the source. A failure in the first step leaves the source in the list. */
  private forgetSource(sourceId: string): void {
    try {
      this.options.agent.removeConnectorItems(sourceId);
    } catch {
      throw new Error(SOURCE_SAVE_MESSAGE);
    }
    this.saveSources(this.sources().filter(source => source.id !== sourceId));
    this.lastAttempt.delete(sourceId);
    this.counts.delete(sourceId);
  }

  private forgetSourceQuietly(sourceId: string): void {
    try {
      this.forgetSource(sourceId);
    } catch (error) {
      this.report(error);
    }
  }

  /** Refuses a sign-in when the account is already connected or the list is full. */
  private checkRoom(provider: CloudProviderId): void {
    if (this.sourceOf(provider) !== undefined) throw new Error(ALREADY_CONNECTED_MESSAGE);
    if (this.sources().length >= CONNECTOR_SOURCE_MAX) throw new Error(SOURCE_FULL_MESSAGE);
  }

  private async saveTokens(provider: CloudProviderId, tokens: Tokens, message: string): Promise<void> {
    try {
      await this.options.tokens.save(provider, tokens);
    } catch {
      throw new CloudConnectorError('store', message);
    }
  }

  private async removeTokens(provider: CloudProviderId): Promise<void> {
    try {
      await this.options.tokens.remove(provider);
    } catch {
      throw new CloudConnectorError('store', TOKEN_REMOVE_MESSAGE);
    }
  }

  private async removeTokensQuietly(provider: CloudProviderId): Promise<void> {
    try {
      await this.removeTokens(provider);
    } catch (error) {
      this.report(error);
    }
  }

  private saveSources(connectors: ConnectorSource[]): void {
    try {
      this.options.agent.updateConfig({ connectors });
    } catch {
      throw new Error(SOURCE_SAVE_MESSAGE);
    }
  }

  /** Writes one request to the network ledger: the host, the path without any query, the outcome and the byte count. */
  private record(entry: CallEntry): void {
    const ok = entry.status >= 200 && entry.status <= 299;
    try {
      this.options.agent.recordNetworkCall({
        ts: entry.at,
        purpose: 'connector',
        host: entry.host,
        path: entry.path.split(/[?#]/)[0] ?? '',
        bytes: entry.bytes,
        outcome: ok ? 'ok' : 'failed',
      });
    } catch {
      this.report(new Error(LEDGER_FAILED_MESSAGE));
    }
  }

  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(task);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private report(error: unknown): void {
    const message = fixedMessage(error);
    if (this.options.report) this.options.report(message);
    else console.error(message);
  }

  private sources(): ConnectorSource[] {
    return this.options.agent.configuration.connectors;
  }

  private cloudSources(): ConnectorSource[] {
    return this.sources().filter(source => isCloudKind(source.kind));
  }

  private sourceOf(provider: CloudProviderId): ConnectorSource | undefined {
    const kind = SOURCE_KIND[provider];
    return this.sources().find(source => source.kind === kind);
  }

  private isSaved(sourceId: string): boolean {
    return this.sources().some(source => source.id === sourceId);
  }

  private providerOf(provider: CloudProviderId): CloudProvider {
    return (this.options.providers ?? CLOUD_PROVIDERS)[provider];
  }

  /** The provider with the client id this run has for it. A blank id means the provider is not configured. */
  private configured(provider: CloudProviderId): ConfiguredProvider {
    const clientId = this.options.clientIds[provider]?.trim();
    return { ...this.providerOf(provider), clientId: clientId ? clientId : undefined };
  }
}
