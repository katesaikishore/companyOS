import { randomBytes } from 'node:crypto';
import type { TwinConfig } from '@companyos/twin-core';
import {
  SOURCE_MISSING_MESSAGE,
  checkSourcePath,
  runLocalSource,
  type ConnectorStore,
  type LocalImportOutcome,
} from './connectors-runner';
import { CONNECTOR_SOURCE_MAX, connectorLabel, type LocalConnectorKind } from './connectors-validate';

/**
 * The local connectors' schedule and their three actions: add, remove and import now. A local source is read again at most
 * once every six hours while the app runs. The check that starts an import runs every 30 minutes, so an import that a gate
 * held back is taken at the first check the gate allows. Nothing here reaches the network.
 *
 * Every change to the source list and every import runs one at a time, through one queue, so a removal never races an
 * import that is storing the same source's items. A task that runs past TASK_TIMEOUT_MS is stopped, so one stuck read
 * cannot hold the queue or the check.
 */

export const IMPORT_INTERVAL_MS = 6 * 60 * 60_000;
export const CHECK_INTERVAL_MS = 30 * 60_000;
export const TASK_TIMEOUT_MS = 10 * 60_000;

export const SOURCE_FULL_MESSAGE = 'You can connect at most 20 sources. Remove one first.';
export { SOURCE_MISSING_MESSAGE };
export const SOURCE_SAVE_MESSAGE = 'The source list could not be saved. Nothing was changed.';
export const TASK_TIMEOUT_MESSAGE = 'The source took too long to read. The import was stopped.';

type ConnectorSource = TwinConfig['connectors'][number];

/** The capture state the import check reads. Each part holds the import back while it is true. */
export interface ImportGate {
  paused: boolean;
  locked: boolean;
  idle: boolean;
}

export interface LocalConnectorServiceOptions {
  agent: ConnectorStore;
  now: () => number;
  gate: () => ImportGate;
  /** Receives a fixed sentence when a scheduled import fails. The sentence never holds a path or an item's text. */
  report?: (message: string) => void;
}

/**
 * Whether a source is due. The wait starts at its last import or its last attempt, whichever is later, so a source that
 * failed is not read again in a loop. A time in the future means the clock moved back, and the source is due now.
 */
export function isImportDue(
  source: { lastImportedAt?: number | undefined },
  lastAttemptAt: number | undefined,
  now: number,
): boolean {
  const last = Math.max(source.lastImportedAt ?? 0, lastAttemptAt ?? 0);
  if (last > now) return true;
  return now - last >= IMPORT_INTERVAL_MS;
}

/** Settles like the work does, or rejects with TASK_TIMEOUT_MESSAGE when the work has not settled within `ms`. */
function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(TASK_TIMEOUT_MESSAGE)), ms);
  });
  return Promise.race([work, limit]).finally(() => clearTimeout(timer));
}

export class LocalConnectorService {
  /** When each source was last tried, by id, whether or not the try worked. Kept in memory: a restart starts the wait again. */
  private readonly lastAttempt = new Map<string, number>();
  /** The item count of each source's last successful import this session. Not saved. */
  private readonly counts = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private queue: Promise<unknown> = Promise.resolve();
  private checking = false;

  constructor(private readonly options: LocalConnectorServiceOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), CHECK_INTERVAL_MS);
    this.timer.unref?.();
  }

  /** Stops the check and forgets the attempt times. A stopped service imports nothing on its own. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastAttempt.clear();
  }

  /**
   * One check. It imports each due local source, unless capture is paused, the screen is locked or the person is away. The
   * gate is read again before each source. A check that starts while another runs does nothing. It never throws.
   */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      const now = this.options.now();
      const due = this.sources().filter(source => isImportDue(source, this.lastAttempt.get(source.id), now));
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
   * Reads one source now and replaces its items. The person asked for it, so the capture gates do not apply. Resolves to the
   * items stored, or rejects with a fixed sentence.
   */
  importNow(id: string): Promise<number> {
    return this.enqueue(() => this.importOne(id));
  }

  /**
   * Adds a source the person picked, then imports it once. A source whose first import fails is not kept, so the list only
   * holds sources that work. Resolves to the items stored.
   */
  addSource(kind: LocalConnectorKind, path: string): Promise<number> {
    return this.enqueue(async () => {
      if (this.sources().length >= CONNECTOR_SOURCE_MAX) throw new Error(SOURCE_FULL_MESSAGE);
      const problem = await checkSourcePath(kind, path);
      if (problem !== undefined) throw new Error(problem);
      const source = {
        id: randomBytes(16).toString('hex'),
        kind,
        label: connectorLabel(kind, path),
        path,
        createdAt: this.options.now(),
      };
      this.saveSources([...this.sources(), source]);
      try {
        return await this.importOne(source.id);
      } catch (error) {
        this.discard(source.id);
        throw error;
      }
    });
  }

  /** Removes a source and its items. The files it read are not changed. */
  removeSource(id: string): Promise<void> {
    return this.enqueue(async () => {
      if (!this.sources().some(source => source.id === id)) throw new Error(SOURCE_MISSING_MESSAGE);
      this.discard(id);
    });
  }

  /** The item count of each source's last import this session, by source id. */
  lastCounts(): Record<string, number> {
    return Object.fromEntries(this.counts);
  }

  private sources(): ConnectorSource[] {
    return this.options.agent.configuration.connectors;
  }

  /** Runs one source's import. Throws the fixed sentence when the import fails, and keeps the items it had. */
  private async importOne(id: string): Promise<number> {
    const source = this.sources().find(item => item.id === id);
    if (!source) throw new Error(SOURCE_MISSING_MESSAGE);
    this.lastAttempt.set(id, this.options.now());
    const outcome: LocalImportOutcome = await runLocalSource(source, {
      agent: this.options.agent,
      now: this.options.now,
    });
    if (!outcome.ok) throw new Error(outcome.message);
    this.counts.set(id, outcome.count);
    return outcome.count;
  }

  /** Removes a source's items, then the source itself. A failure in the first step leaves the source in the list. */
  private discard(id: string): void {
    try {
      this.options.agent.removeConnectorItems(id);
    } catch {
      throw new Error(SOURCE_SAVE_MESSAGE);
    }
    this.saveSources(this.sources().filter(source => source.id !== id));
    this.lastAttempt.delete(id);
    this.counts.delete(id);
  }

  /** Writes the source list. A failure is a fixed sentence, since the engine's own message could carry a path. */
  private saveSources(connectors: ConnectorSource[]): void {
    try {
      this.options.agent.updateConfig({ connectors });
    } catch {
      throw new Error(SOURCE_SAVE_MESSAGE);
    }
  }

  /** Queues a task. The task's own time limit starts when it begins, not when it is queued. */
  private enqueue<T>(task: () => Promise<T>): Promise<T> {
    const next = this.queue.then(() => withTimeout(task(), TASK_TIMEOUT_MS));
    this.queue = next.catch(() => undefined);
    return next;
  }

  private report(error: unknown): void {
    const message = error instanceof Error ? error.message : '';
    const fixed = message === '' ? 'The source could not be read. Its items were not changed.' : message;
    if (this.options.report) this.options.report(fixed);
    else console.error(fixed);
  }
}
