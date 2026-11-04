import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseDiscordWindow, type AccessibilityNode, type DiscordMessage } from '@companyos/twin-core';

/**
 * Reads the Discord app's messages while it is open, with agent-desktop, read only: each Discord window's accessibility
 * tree is snapshotted and its messages parsed. Nothing is clicked, typed or scrolled, so Discord shows only what the person
 * opened. Each new message is stored once. Which messages were stored is kept as short hashes in a file, never their text,
 * so a restart does not store them again. It runs inside the app on a timer; nothing outside the app drives it.
 */

export type Exec = (binary: string, args: readonly string[]) => Promise<string>;

export interface DiscordReaderOptions {
  /** The agent-desktop program, as set in Settings. Empty means it is not set, and nothing is read. */
  binary: () => string;
  /** True when reading may happen now: the setting is on, screen text is on, capture is not paused or locked, and Discord is not excluded. */
  allowed: () => boolean;
  /** Stores one message. Resolves to false when the store refused it. */
  store: (message: DiscordMessage) => boolean;
  /** The file of hashes of stored messages. */
  seenFile: string;
  exec?: Exec;
  now?: () => number;
  intervalMs?: number;
  /** Told after each read that ran, with the number of new messages stored. */
  onRead?: (stored: number) => void;
}

export interface DiscordReadState {
  /** When the last read ran, whether or not it found anything new. */
  lastReadAt?: number;
  /** Messages stored since the app started. */
  storedThisRun: number;
  /** Why the last read could not run, in a few words, when it could not. */
  problem?: 'not_set' | 'not_running' | 'unreadable';
}

const READ_INTERVAL_MS = 60_000;
const CALL_TIMEOUT_MS = 30_000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;
const MAX_SEEN = 20_000;
const WINDOW_ID = /^(?!-)[A-Za-z0-9._:-]{1,120}$/;

const defaultExec: Exec = (binary, args) =>
  new Promise(resolve => {
    execFile(binary, [...args], { timeout: CALL_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES }, (_error, stdout) => resolve(stdout ?? ''));
  });

function parse(stdout: string): { ok?: boolean; data?: unknown } | undefined {
  try {
    return JSON.parse(stdout) as { ok?: boolean; data?: unknown };
  } catch {
    return undefined;
  }
}

/** A short hash of one message, so the same message read again is recognised without keeping its text. */
export function messageKey(message: DiscordMessage): string {
  return createHash('sha256').update(`${message.conversation}\u0000${message.author}\u0000${message.ts}\u0000${message.text}`).digest('hex').slice(0, 20);
}

export class DiscordReader {
  private timer: ReturnType<typeof setInterval> | undefined;
  private reading: Promise<number> | undefined;
  private seen: string[] = [];
  private seenSet = new Set<string>();
  readonly state: DiscordReadState = { storedThisRun: 0 };

  constructor(private readonly options: DiscordReaderOptions) {
    try {
      const saved = JSON.parse(readFileSync(options.seenFile, 'utf8')) as unknown;
      if (Array.isArray(saved)) this.seen = saved.filter((key): key is string => typeof key === 'string').slice(-MAX_SEEN);
    } catch {
      this.seen = [];
    }
    this.seenSet = new Set(this.seen);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.readNow(), this.options.intervalMs ?? READ_INTERVAL_MS);
    void this.readNow();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  /** Forgets which messages were stored, as when the person deletes captured text. */
  forget(): void {
    this.seen = [];
    this.seenSet.clear();
    this.save();
  }

  /** Reads every Discord window once. Resolves to the number of new messages stored. One read runs at a time. */
  readNow(): Promise<number> {
    if (!this.reading) this.reading = this.read().finally(() => (this.reading = undefined));
    return this.reading;
  }

  private async read(): Promise<number> {
    if (!this.options.allowed()) return 0;
    const binary = this.options.binary().trim();
    const now = this.options.now ?? Date.now;
    this.state.lastReadAt = now();
    if (!binary) {
      this.state.problem = 'not_set';
      return 0;
    }
    const exec = this.options.exec ?? defaultExec;
    const listed = parse(await exec(binary, ['list-windows', '--app', 'Discord']));
    const windows = Array.isArray(listed?.data) ? (listed.data as Array<{ id?: unknown; title?: unknown }>) : [];
    if (!listed?.ok || windows.length === 0) {
      this.state.problem = 'not_running';
      return 0;
    }
    let stored = 0;
    let readable = false;
    for (const window of windows) {
      if (typeof window.id !== 'string' || !WINDOW_ID.test(window.id)) continue;
      // A deeper tree than the default reaches the messages, and Discord's renderer needs longer than the default deadline.
      const snapshot = parse(await exec(binary, ['snapshot', '--window-id', window.id, '--compact', '--max-depth', '30', '--timeout-ms', '20000']));
      const tree = (snapshot?.data as { tree?: AccessibilityNode } | undefined)?.tree;
      if (!snapshot?.ok || !tree) continue;
      readable = true;
      // The capture checks are asked again before anything is stored, so a pause during the read stores nothing.
      if (!this.options.allowed()) return stored;
      for (const message of parseDiscordWindow(tree, typeof window.title === 'string' ? window.title : '', now())) {
        const key = messageKey(message);
        if (this.seenSet.has(key)) continue;
        if (!this.options.store(message)) continue;
        this.seenSet.add(key);
        this.seen.push(key);
        stored++;
      }
    }
    this.state.problem = readable ? undefined : 'unreadable';
    this.options.onRead?.(stored);
    if (stored > 0) {
      this.state.storedThisRun += stored;
      if (this.seen.length > MAX_SEEN) {
        this.seen = this.seen.slice(-MAX_SEEN);
        this.seenSet = new Set(this.seen);
      }
      this.save();
    }
    return stored;
  }

  private save(): void {
    try {
      writeFileSync(this.options.seenFile, JSON.stringify(this.seen), { mode: 0o600 });
    } catch {
      // Without the file, a restart may store a message again. That is a duplicate, never a loss.
    }
  }
}
