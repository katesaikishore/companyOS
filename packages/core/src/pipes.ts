import { z } from 'zod';
import type { CaptureHitView, CaptureSearchRequest } from './contract';
import { PIPE_KINDS, PipesSchema, type Pipe, type PipeKind } from './types';

/**
 * Pipes: saved searches that run on a schedule and do one local thing with the result. A pipe is data, never code. It
 * reads only the text the twin has already stored, through the same search the Recall page uses, so an excluded app stays
 * out. A write pipe keeps the matches of its newest run in the encrypted store. Nothing in this file writes a file or
 * reaches the network.
 */

/** Most matches one run reads. The engine's search returns no more than this, and a full run says so. */
export const PIPE_MATCH_LIMIT = 200;
/** The most characters of one match's text that a kept run holds. A longer snippet is cut to this. */
export const PIPE_OUTPUT_TEXT_MAX = 1000;
const PIPE_OUTPUT_APP_MAX = 500;
/** The id of a pipe, as the config checks it. The same rule applies wherever a pipe id is taken from a caller. */
export const PIPE_ID = /^[A-Za-z0-9-]{8,40}$/;

/** One match of a kept run: when it was stored, the app it came from, its kind and its text on one line. */
export const PipeOutputItemSchema = z
  .object({
    ts: z.number().int().nonnegative(),
    app: z.string().max(PIPE_OUTPUT_APP_MAX).nullable(),
    kind: z.enum(PIPE_KINDS),
    text: z.string().max(PIPE_OUTPUT_TEXT_MAX),
  })
  .strict();
export type PipeOutputItem = z.infer<typeof PipeOutputItemSchema>;

/** The newest run of one write pipe: when it ran, and its matches, at most PIPE_MATCH_LIMIT. */
export const PipeOutputSchema = z
  .object({
    ranAt: z.number().int().nonnegative(),
    items: z.array(PipeOutputItemSchema).max(PIPE_MATCH_LIMIT),
  })
  .strict();
export type PipeOutput = z.infer<typeof PipeOutputSchema>;
/** How many app names a notification names before it counts the rest. */
const NOTICE_APP_NAMES = 3;
const MINUTE_MS = 60_000;
const INVALID_PIPES = 'Invalid pipes: a pipe has a field or value the twin does not accept.';

/**
 * Checks a list of pipes, as saved or as edited, and returns it. Throws one fixed sentence and never the input, so a name or
 * a search that was refused is not repeated in an error or a log.
 */
export function parsePipes(value: unknown): Pipe[] {
  const parsed = PipesSchema.safeParse(value);
  if (!parsed.success) throw new Error(INVALID_PIPES);
  return parsed.data;
}

/**
 * Whether a pipe is due. It must be enabled, and its interval must have passed since the baseline, which is the time of its
 * last run or, before its first run, the time the scheduler first saw it.
 */
export function isPipeDue(pipe: Pipe, baseline: number, now: number): boolean {
  return pipe.enabled && now - baseline >= pipe.intervalMinutes * MINUTE_MS;
}

/** What the person allows at the moment, read from the capture state and the operating system. */
export interface PipeGate {
  /** The "stop all automations" switch. Pipes wait while it is off, as automations do. */
  automationsEnabled: boolean;
  paused: boolean;
  locked: boolean;
  idle: boolean;
  /** Whether a password or other secure field may hold focus. 'unknown' when the system cannot say. */
  secureInput: boolean | 'unknown';
}

export interface PipeDecision {
  run: boolean;
  /** A fixed sentence in plain words. It never holds captured content. */
  reason: string;
}

/**
 * Whether pipes may run now. The first check that fails gives the reason. Every check fails closed, as the screen and
 * microphone checks do, so an unknown secure input state holds the pipes too.
 */
export function pipeDecision(gate: PipeGate): PipeDecision {
  if (!gate.automationsEnabled) return hold('Automations are stopped, so pipes wait.');
  if (gate.paused) return hold('Capture is paused, so pipes wait.');
  if (gate.locked) return hold('The screen is locked, so pipes wait.');
  if (gate.idle) return hold('You are away, so pipes wait.');
  if (gate.secureInput === 'unknown') return hold('Secure input cannot be checked, so pipes wait.');
  if (gate.secureInput) return hold('A password field may have focus, so pipes wait.');
  return { run: true, reason: 'Pipes may run.' };
}

function hold(reason: string): PipeDecision {
  return { run: false, reason };
}

export interface PipeRunDeps {
  now: () => number;
  /** The engine's search. It already leaves out the apps on the exclusion list. */
  search: (request: CaptureSearchRequest) => CaptureHitView[];
}

export interface PipeRunResult {
  pipeId: string;
  /** When the run read the window, in ms. */
  ranAt: number;
  /** Matches stored in the window, at most PIPE_MATCH_LIMIT. */
  count: number;
  /** True when the search was full, so there may be more matches than count. */
  truncated: boolean;
  /** The distinct app names of the matches, newest match first. Holds no item text. */
  apps: string[];
  /**
   * The notification text: the pipe's name, the count and the app names. Empty when nothing matched. It never holds the
   * text of an item, only the number and the names.
   */
  notice: string;
  /**
   * The matches of this run, as a write pipe keeps them. They hold stored text, so they go only to the encrypted store, and
   * a notify pipe does not keep them.
   */
  items: PipeOutputItem[];
}

/**
 * Runs one pipe over the text stored from `since` to now. The window is inclusive at both ends. Pure: the clock and the
 * search are given, so a test can run it with a fake time and a fake search.
 */
export function runPipe(pipe: Pipe, since: number, deps: PipeRunDeps): PipeRunResult {
  const ranAt = Math.floor(deps.now());
  const from = Math.min(Math.max(0, Math.floor(since)), ranAt);
  // The engine searches one kind at a time, so a pipe with no kind asks for each of its kinds. Typed text is never asked
  // for, and a hit of any other kind is dropped here as well. The newest matches are kept, up to the limit.
  const kinds: readonly PipeKind[] = pipe.kind === undefined ? PIPE_KINDS : [pipe.kind];
  const hits = kinds
    .flatMap(kind => deps.search(requestFor(pipe, kind, from, ranAt)))
    .filter(hit => kinds.includes(hit.kind as PipeKind))
    .sort((a, b) => b.ts - a.ts)
    .slice(0, PIPE_MATCH_LIMIT);
  const count = hits.length;
  const truncated = count >= PIPE_MATCH_LIMIT;
  const apps = distinctApps(hits);
  return {
    pipeId: pipe.id,
    ranAt,
    count,
    truncated,
    apps,
    notice: count === 0 ? '' : noticeFor(pipe.name, count, truncated, apps),
    items: hits.map(itemFor),
  };
}

function requestFor(pipe: Pipe, kind: PipeKind, from: number, to: number): CaptureSearchRequest {
  const request: CaptureSearchRequest = { text: pipe.query, kind, from, to };
  if (pipe.app !== undefined) request.app = pipe.app;
  return request;
}

function distinctApps(hits: readonly CaptureHitView[]): string[] {
  const apps: string[] = [];
  for (const hit of hits) if (hit.app !== null && !apps.includes(hit.app)) apps.push(hit.app);
  return apps;
}

function noticeFor(name: string, count: number, truncated: boolean, apps: readonly string[]): string {
  const countText = truncated ? `${PIPE_MATCH_LIMIT} or more` : String(count);
  const noun = !truncated && count === 1 ? 'match' : 'matches';
  const shown = apps.slice(0, NOTICE_APP_NAMES);
  const more = apps.length - shown.length;
  const appText = apps.length === 0 ? '' : ` in ${shown.join(', ')}${more > 0 ? ` and ${more} more` : ''}`;
  return `${name}: ${countText} new ${noun}${appText}.`;
}

/** One match as a kept run holds it. The kind is one of the pipe kinds, since runPipe drops any other kind before this. */
function itemFor(hit: CaptureHitView): PipeOutputItem {
  return {
    ts: hit.ts,
    app: hit.app,
    kind: hit.kind as PipeKind,
    text: oneLine(hit.snippet).slice(0, PIPE_OUTPUT_TEXT_MAX),
  };
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
