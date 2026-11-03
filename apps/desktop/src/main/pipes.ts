import {
  isPipeDue,
  pipeDecision,
  runPipe,
  type CaptureHitView,
  type CaptureSearchRequest,
  type Pipe,
  type PipeGate,
  type PipeOutput,
} from '@companyos/twin-core';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pipe scheduler in the main process. Every minute it finds the pipes that are due, and when the gates allow pipes it
 * runs them. A run reads the stored text through the engine's search, then shows a notice, or hands its matches to the agent,
 * which keeps the newest run encrypted in the store. The time of each last run is kept in memory only, so a restart starts each
 * wait again. Nothing here writes a file or reaches the network.
 */

/** How often the scheduler looks for due pipes. A pipe runs at most this long after it falls due. */
export const PIPE_TICK_MS = 60_000;
/**
 * The folder the earlier version wrote its pipe files to, as plain text. Nothing writes there now. Its files are removed when
 * the app starts and when captured text is deleted.
 */
const LEGACY_PIPES_FOLDER = 'pipes';
/** What the log says. It names no pipe, no error and no text, because an error can carry the text it was given. */
const PIPE_FAILED = 'A pipe did not run. Its text is not logged.';
const CHECK_FAILED = 'The pipes could not be checked. Their text is not logged.';

interface PipeSchedulerOptions {
  now: () => number;
  /** The saved pipes, read on each check, so an edit takes effect at the next one. */
  pipes: () => readonly Pipe[];
  /** The gates a run waits for. Called only when a pipe is due. */
  gate: () => Promise<PipeGate>;
  /** The engine's search. It leaves out the apps on the exclusion list. */
  search: (request: CaptureSearchRequest) => CaptureHitView[];
  /** Shows a notice. The text is a count, the app names and the pipe's own name. Never item text. */
  notify: (text: string) => void;
  /**
   * Hands a write pipe's newest run to the agent, which keeps it encrypted in the store and replaces the run kept before it. The
   * agent keeps it only for a saved pipe that is on and keeps its matches, so a pipe removed or turned off during a run keeps nothing.
   */
  storeOutput: (pipeId: string, output: PipeOutput) => void;
  /** Receives a fixed sentence when a pipe or a check fails. Defaults to the error log. */
  report?: (message: string) => void;
}

export class PipeScheduler {
  private readonly lastRun = new Map<string, number>();
  /** When the scheduler first saw each pipe. A pipe with no run yet waits one interval from then. */
  private readonly firstSeen = new Map<string, number>();
  private timer: ReturnType<typeof setInterval> | undefined;
  private checking = false;

  constructor(private readonly options: PipeSchedulerOptions) {}

  start(): void {
    if (this.timer !== undefined) return;
    this.timer = setInterval(() => void this.tick(), PIPE_TICK_MS);
    this.timer.unref?.();
  }

  /** Stops the timer and forgets the last runs. A stopped scheduler runs nothing. */
  stop(): void {
    clearInterval(this.timer);
    this.timer = undefined;
    this.lastRun.clear();
    this.firstSeen.clear();
  }

  /** One check. A check that starts while another is running does nothing. It never throws. */
  async tick(): Promise<void> {
    if (this.checking) return;
    this.checking = true;
    try {
      await this.check();
    } catch {
      this.report(CHECK_FAILED);
    } finally {
      this.checking = false;
    }
  }

  private async check(): Promise<void> {
    const now = this.options.now();
    const pipes = this.options.pipes();
    for (const pipe of pipes) if (!this.firstSeen.has(pipe.id)) this.firstSeen.set(pipe.id, now);
    this.forget(pipes);
    const due = pipes.filter(pipe => isPipeDue(pipe, this.baseline(pipe.id), now));
    if (due.length === 0) return;
    const decision = pipeDecision(await this.options.gate());
    if (!decision.run) return;
    // The saved pipes are read again after the gates, so a pipe turned off or removed meanwhile is not run.
    const current = this.options.pipes();
    for (const pipe of due) {
      if (current.some(item => item.id === pipe.id && item.enabled)) await this.runOne(pipe, this.baseline(pipe.id));
    }
  }

  /** The time a pipe's window starts after: its last run, else the time it was first seen. */
  private baseline(id: string): number {
    return this.lastRun.get(id) ?? this.firstSeen.get(id) ?? this.options.now();
  }

  private forget(pipes: readonly Pipe[]): void {
    const live = new Set(pipes.map(pipe => pipe.id));
    for (const id of [...this.lastRun.keys()]) if (!live.has(id)) this.lastRun.delete(id);
    for (const id of [...this.firstSeen.keys()]) if (!live.has(id)) this.firstSeen.delete(id);
  }

  private async runOne(pipe: Pipe, since: number): Promise<void> {
    // Set before the run, so a run that fails waits a full interval before it is tried again.
    this.lastRun.set(pipe.id, this.options.now());
    try {
      const result = runPipe(pipe, since + 1, { now: () => this.options.now(), search: this.options.search });
      if (pipe.action === 'write') this.options.storeOutput(pipe.id, { ranAt: result.ranAt, items: result.items });
      else if (result.count > 0) this.options.notify(result.notice);
    } catch {
      this.report(PIPE_FAILED);
    }
  }

  private report(message: string): void {
    if (this.options.report) this.options.report(message);
    else console.error(message);
  }
}

/**
 * Removes the folder the earlier version wrote its pipe files to, with every file in it, since those files hold text as plain
 * Markdown. A folder that is not there has nothing to remove.
 */
export async function removeLegacyPipeFiles(userData: string): Promise<void> {
  await rm(join(userData, LEGACY_PIPES_FOLDER), { recursive: true, force: true });
}
