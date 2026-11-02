import {
  isPipeDue,
  pipeDecision,
  runPipe,
  type CaptureHitView,
  type CaptureSearchRequest,
  type Pipe,
  type PipeGate,
} from '@companyos/twin-core';
import { mkdir, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * The pipe scheduler in the main process. Every minute it finds the pipes that are due, and when the gates allow pipes it
 * runs them. A run reads the stored text through the engine's search, then shows a notice or writes a file. The time of
 * each last run is kept in memory only, so a restart starts each wait again. Nothing here reaches the network.
 */

/** How often the scheduler looks for due pipes. A pipe runs at most this long after it falls due. */
export const PIPE_TICK_MS = 60_000;
/** The folder inside the app's data folder that holds the files of write pipes. */
const PIPES_FOLDER = 'pipes';
const PIPE_ID = /^[A-Za-z0-9-]{8,40}$/;
/** What the log says. It names no pipe, no error and no text, because an error can carry the text it was given. */
const PIPE_FAILED = 'A pipe did not run. Its text is not logged.';
const CHECK_FAILED = 'The pipes could not be checked. Their text is not logged.';
const BAD_ID = 'A pipe has an id that cannot be a file name.';

export interface PipeSchedulerOptions {
  now: () => number;
  /** The saved pipes, read on each check, so an edit takes effect at the next one. */
  pipes: () => readonly Pipe[];
  /** The gates a run waits for. Called only when a pipe is due. */
  gate: () => Promise<PipeGate>;
  /** The engine's search. It leaves out the apps on the exclusion list. */
  search: (request: CaptureSearchRequest) => CaptureHitView[];
  /** Shows a notice. The text is a count, the app names and the pipe's own name. Never item text. */
  notify: (text: string) => void;
  writeOutput: (pipeId: string, markdown: string) => Promise<void>;
  /** Removes every file in the pipes folder except the files of the kept pipe ids. */
  pruneOutputs: (keep: ReadonlySet<string>) => Promise<void>;
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
    // A pipe that is off, or that does not write a file, keeps no file. A removed pipe's file goes too.
    await this.options.pruneOutputs(new Set(pipes.filter(pipe => pipe.enabled && pipe.action === 'write').map(pipe => pipe.id)));
    const due = pipes.filter(pipe => isPipeDue(pipe, this.baseline(pipe.id), now));
    if (due.length === 0) return;
    const decision = pipeDecision(await this.options.gate());
    if (!decision.run) return;
    for (const pipe of due) await this.runOne(pipe, this.baseline(pipe.id));
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
      if (pipe.action === 'write') await this.options.writeOutput(pipe.id, result.markdown);
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

/** The folder of the write pipes' files, inside the app's data folder. */
export function pipeOutputFolder(userData: string): string {
  return join(userData, PIPES_FOLDER);
}

/**
 * Replaces the file of one write pipe. The text goes to a temporary file first and is renamed over the old one, so a crash
 * never leaves half a file. The file is readable by this user only, where the system keeps file modes.
 */
export async function writePipeOutput(folder: string, pipeId: string, markdown: string): Promise<void> {
  if (!PIPE_ID.test(pipeId)) throw new Error(BAD_ID);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  const target = join(folder, `${pipeId}.md`);
  const temporary = `${target}.tmp`;
  await writeFile(temporary, markdown, { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, target);
}

/**
 * Removes every entry in the pipes folder except the files of the kept pipe ids. Called with no ids, it removes them all,
 * which is what deleting captured text and changing the exclusions need. A folder that does not exist has nothing to remove.
 */
export async function pruneOutputs(folder: string, keep: ReadonlySet<string>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const kept = new Set([...keep].map(id => `${id}.md`));
  for (const name of names) {
    if (kept.has(name)) continue;
    await rm(join(folder, name), { recursive: true, force: true });
  }
}
