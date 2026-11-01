import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { StepRefusedError, parseKeyChord, type Executor } from '@companyos/twin-core';

/**
 * The optional "hands" executor. An external agent-desktop program takes over the key-press step, and it counts an app's
 * windows before a focus by name. The focus itself is the built-in adapter's. The program is not bundled. Its path is a
 * setting that defaults to empty, and an empty path keeps the built-in adapters, so nothing in this file runs unless a
 * person sets the path.
 *
 * The program is the agent-desktop CLI (vercel-labs/agent-desktop). It is called with a fixed argument array and never
 * through a shell. A call names either the app or one of its windows:
 *   <program> list-windows --app <name>          lists the app's windows as a JSON envelope, read only to count them
 *   <program> focus-window --app <name>          brings the app's window to the front and confirms focus
 *   <program> press <chord> --headed --app <name>  brings the app's window forward, then sends the chord
 *   <program> focus-window --window-id <id>      the same, for one window from list-windows
 *   <program> press <chord> --headed --window-id <id>  the same, for one window from list-windows
 * A window ID is used when it is given, and the app name is then only for logs. Without one, the program is first asked
 * how many windows the app has. A focus by name is refused as ambiguous when the app has more than one window, because
 * the app could come forward with a window the person did not mean. The focus itself is then the built-in adapter's, so
 * the program does not move the pointer for it. A press by name is refused the same way, since its first step is a focus.
 * A zero count, or a list-windows call that fails, lets the focus call run and report its own error. The listing is never
 * kept. This module never picks a window for the caller. The CLI's exit status 1 is shared by every structured error, so
 * AMBIGUOUS_TARGET is read from the JSON envelope the program prints on stdout, by a match that keeps only its position
 * and never the output. The error code of a failed focus or press is read the same way, and only that code is kept. A press
 * is always preceded by a focus-window call with the same target. Exit status 0 is success.
 * Any other status, a signal, a timeout or too much output is a failure.
 */

/** How long one call may run before the program is stopped. */
export const AGENT_DESKTOP_TIMEOUT_MS = 10_000;
/** The most output, across stdout and stderr, that one call may produce. Output is counted and discarded, never kept. */
const MAX_OUTPUT_BYTES = 16 * 1024;
/** How long output is still read after the program exits. A child that inherited the pipes can hold them open. */
const EXIT_DRAIN_MS = 500;
const MAX_PATH_LENGTH = 512;
/** An application name: a letter or digit first, then letters, digits, spaces and . _ ( ) -. No quotes, slashes, flags or control characters. */
const APP_NAME = /^[\p{L}\p{N}][\p{L}\p{N} ._()-]{0,99}$/u;
/** Key chord text. The exact form is then checked by parseKeyChord, the same rule the step schema uses. */
const CHORD_TEXT = /^[a-z0-9+]{1,40}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;
/** A window ID from list-windows, such as "w-1.0-org-a11y-atspi-accessible-2". No leading dash, so it cannot read as a flag. */
const WINDOW_ID = /^(?!-)[A-Za-z0-9._:-]{1,120}$/;
/** The error code the CLI prints in its JSON envelope when a target matches more than one window. */
const AMBIGUOUS_CODE = Buffer.from('"AMBIGUOUS_TARGET"');
/** A CLI error code: a letter, then upper-case letters, digits and underscores. Anything else is not recorded. */
const ERROR_CODE = /^[A-Z][A-Z0-9_]{1,39}$/;

export type HandsStep = 'focus_app' | 'press_shortcut';
export type HandsFailure =
  | 'blocked'
  | 'invalid_input'
  | 'exit'
  | 'ambiguous'
  | 'signal'
  | 'timeout'
  | 'output_limit'
  | 'spawn_error';
export type HandsResult = { ok: true } | { ok: false; failure: HandsFailure; reason: string };

/**
 * What is kept about one call that started the program: the step, how it ended, how long it took, and the CLI's error
 * code when it printed one. The application name, the chord and the error message are never kept, since the message can
 * name an app or a window.
 */
export interface HandsRecord {
  step: HandsStep;
  exit: number | HandsFailure;
  durationMs: number;
  code?: string;
}

export interface HandsOptions {
  /** The program's path, as set in Settings. */
  binary: string;
  /**
   * Called once for each focus-window or press call that ends, and once for a step refused for several windows. The
   * list-windows check that comes before a focus by name is not recorded.
   */
  record?: (entry: HandsRecord) => void;
  /** Overrides the call timeout. Tests use it; the app does not. */
  timeoutMs?: number;
}

const MESSAGES = {
  missing: 'No agent-desktop program is set. Set its path in Settings to use it for focus and key steps.',
  invalidPath: 'The agent-desktop path is not valid.',
  relative: 'The agent-desktop path must be an absolute path to the program.',
  notFile: 'No program file exists at the agent-desktop path.',
  app: 'The application name is not one the agent-desktop program accepts.',
  window: 'The window ID is not one the agent-desktop program accepts.',
  ambiguous: 'More than one window of this app is open. Choose a window, then try again.',
  chord: 'The key chord is not one the agent-desktop program accepts.',
  timeout: 'The agent-desktop program did not finish in time.',
  output: 'The agent-desktop program wrote too much output.',
  signal: 'The agent-desktop program was stopped before it finished.',
  spawn: 'The agent-desktop program could not be started.',
} as const;

/** Why the program path cannot be used, or undefined when it can. Blank means off. The disk is checked on every call. */
export function agentDesktopProblem(path: string): string | undefined {
  const value = path.trim();
  if (value === '') return MESSAGES.missing;
  if (value.length > MAX_PATH_LENGTH || CONTROL_CHARACTERS.test(value)) return MESSAGES.invalidPath;
  if (!isAbsolute(value)) return MESSAGES.relative;
  try {
    return statSync(value).isFile() ? undefined : MESSAGES.notFile;
  } catch {
    return MESSAGES.notFile;
  }
}

/** True for an application name the program may be given. It is checked before it reaches the argument list. */
export function isAllowedAppName(app: string): boolean {
  return APP_NAME.test(app) && app === app.trim();
}

/** True for a window ID in the form list-windows prints. Checked before it reaches the argument list. */
export function isAllowedWindowId(windowId: string): boolean {
  return WINDOW_ID.test(windowId);
}

/** The failure table for a streamed match: for each length, the longest proper prefix that is also a suffix of it. */
function failureTable(pattern: Buffer): number[] {
  const table = [0];
  let k = 0;
  for (let i = 1; i < pattern.length; i++) {
    while (k > 0 && pattern[i] !== pattern[k]) k = table[k - 1];
    if (pattern[i] === pattern[k]) k++;
    table[i] = k;
  }
  return table;
}
const AMBIGUOUS_FAILURE = failureTable(AMBIGUOUS_CODE);

/** True for a key chord in the canonical form the step schema accepts, such as "cmd+shift+k". */
export function isAllowedChord(chord: string): boolean {
  return CHORD_TEXT.test(chord) && parseKeyChord(chord) === chord;
}

/** Why the target cannot be used, or undefined when it can. The app name is checked even with a window ID: it is for logs. */
function targetProblem(app: string, windowId: string | undefined): string | undefined {
  if (!isAllowedAppName(app)) return MESSAGES.app;
  if (windowId !== undefined && !isAllowedWindowId(windowId)) return MESSAGES.window;
  return undefined;
}

/** The arguments that name the target: the window when one is given, otherwise the app. Call only after targetProblem. */
function targetArgs(app: string, windowId: string | undefined): string[] {
  return windowId === undefined ? ['--app', app] : ['--window-id', windowId];
}

/**
 * Focuses an application, or one of its windows when windowId is given, through the program. Nothing starts unless the
 * path is usable and the name, and the window ID when there is one, are allowed. A focus by name is refused when the app
 * has more than one window.
 */
export async function focusWithAgentDesktop(options: HandsOptions, app: string, windowId?: string): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, windowId);
  if (invalid) return refused('invalid_input', invalid);
  const several = await refuseSeveralWindows(options, 'focus_app', app, windowId);
  if (several) return several;
  return runProgram(options, 'focus_app', ['focus-window', ...targetArgs(app, windowId)]);
}

/**
 * Presses a key chord in an application, or one of its windows when windowId is given, through the program. Nothing
 * starts unless every input is allowed. A press by name is refused when the app has more than one window.
 */
export async function pressWithAgentDesktop(
  options: HandsOptions,
  app: string,
  shortcut: string,
  windowId?: string,
): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, windowId);
  if (invalid) return refused('invalid_input', invalid);
  if (!isAllowedChord(shortcut)) return refused('invalid_input', MESSAGES.chord);
  // A press by name starts with a focus by name, so it gets the same several-windows check before anything starts.
  const several = await refuseSeveralWindows(options, 'press_shortcut', app, windowId);
  if (several) return several;
  const aim = targetArgs(app, windowId);
  // A headless press sends the keys to the app's process, and a window that is not the key window ignores them. On macOS
  // the CLI still reports success in that case, so the press is headed: it brings the window forward and delivers the
  // keys to it, at the cost of focus and cursor side effects. The focus before it keeps the refusal and failure point.
  const focused = await runProgram(options, 'press_shortcut', ['focus-window', ...aim]);
  if (!focused.ok) return focused;
  return runProgram(options, 'press_shortcut', ['press', shortcut, '--headed', ...aim]);
}

/**
 * The checks a focus by name passes before the built-in adapter focuses the app: the path must be usable, the name must be
 * one the program accepts, and an app with several windows is refused. The program is only asked for the window count, so
 * the focus itself never goes through it. Undefined when the focus may run.
 */
async function checkFocusByName(options: HandsOptions, app: string): Promise<HandsResult | undefined> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  const invalid = targetProblem(app, undefined);
  if (invalid) return refused('invalid_input', invalid);
  return refuseSeveralWindows(options, 'focus_app', app, undefined);
}

/**
 * The runner's executor when the program path is set. A focus by name is the built-in adapter's, after the program has
 * counted the app's windows. A key press goes through the program on macOS and Windows only. On Linux the program's press
 * crashed a GTK 3 test window in most trials, so the built-in press (xdotool on X11) is used there, and the path does not
 * block it. Frontmost-app checks, links and files come from the built-in executor unchanged. While the path is unusable,
 * the focus step is blocked with the reason before anyone is asked, and nothing starts.
 */
export function handsExecutor(base: Executor, options: HandsOptions, platform: NodeJS.Platform = process.platform): Executor {
  const pressThroughProgram = platform !== 'linux';
  return {
    ...base,
    focusApp: async app => {
      const refusal = await checkFocusByName(options, app);
      return refusal ? outcomeOf(refusal) : base.focusApp(app);
    },
    ...(pressThroughProgram
      ? { pressShortcut: async (app: string, shortcut: string) => outcomeOf(await pressWithAgentDesktop(options, app, shortcut)) }
      : {}),
    blockedReason: op => (op === 'press_shortcut' && !pressThroughProgram ? undefined : agentDesktopProblem(options.binary)),
  };
}

/**
 * The runner's view of a result. A refusal for several windows is thrown with its reason, so the runner can show it on
 * the step. Every other failure is a plain false, as before.
 */
function outcomeOf(result: HandsResult): boolean {
  if (result.ok) return true;
  if (result.failure === 'ambiguous') throw new StepRefusedError(result.reason);
  return false;
}

function refused(failure: HandsFailure, reason: string): HandsResult {
  return { ok: false, failure, reason };
}

/** What one call ended with. The output is set only when the caller asked for it, and it is not kept past the caller. */
interface CallResult {
  result: HandsResult;
  exit: number | HandsFailure;
  output?: Buffer;
}

/** Writes one call that ended to the log, if there is one. The log is best effort, so a failing log cannot stall a call. */
function recordStep(options: HandsOptions, step: HandsStep, exit: number | HandsFailure, started: number, code?: string): void {
  try {
    options.record?.({ step, exit, durationMs: Date.now() - started, ...(code === undefined ? {} : { code }) });
  } catch {
    // The log is best effort. A failing log must not leave the call unsettled.
  }
}

/**
 * Refuses a focus by name when the app has more than one window, since focus-window would bring one of them forward. The
 * program is asked for the window list first, and the entries are counted and never kept. A zero count, or a list-windows
 * call that fails, lets the focus call run and report its own error. A window ID names one window, so it is not checked.
 */
async function refuseSeveralWindows(
  options: HandsOptions,
  step: HandsStep,
  app: string,
  windowId: string | undefined,
): Promise<HandsResult | undefined> {
  if (windowId !== undefined) return undefined;
  const started = Date.now();
  const listed = await runCall(options, ['list-windows', '--app', app], true);
  if (!listed.result.ok || windowCount(listed.output) <= 1) return undefined;
  recordStep(options, step, 'ambiguous', started);
  return refused('ambiguous', MESSAGES.ambiguous);
}

/** The number of entries in the data array of a list-windows envelope. Zero when the output cannot be read that way. */
function windowCount(output: Buffer | undefined): number {
  if (output === undefined) return 0;
  try {
    const envelope = JSON.parse(output.toString('utf8')) as { data?: unknown } | null;
    const data = envelope?.data;
    return Array.isArray(data) ? data.length : 0;
  } catch {
    return 0;
  }
}

/**
 * The CLI's error code from its JSON envelope, or undefined when the output has none. The message is read past and never
 * returned, because it can name an app or a window.
 */
function errorCodeOf(output: Buffer | undefined): string | undefined {
  if (output === undefined) return undefined;
  try {
    const envelope = JSON.parse(output.toString('utf8')) as { ok?: unknown; error?: { code?: unknown } } | null;
    if (envelope?.ok !== false) return undefined;
    const code = envelope.error?.code;
    return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
  } catch {
    return undefined;
  }
}

/** Starts the program with no shell, so the argument array reaches it exactly as built. Undefined when the start throws. */
function start(program: string, args: readonly string[]): ChildProcess | undefined {
  try {
    return spawn(program, [...args], { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return undefined;
  }
}

/**
 * Runs one focus-window or press call and records it as one step. Its output is held only until its error code is read,
 * and only that code is recorded.
 */
async function runProgram(options: HandsOptions, step: HandsStep, args: readonly string[]): Promise<HandsResult> {
  const started = Date.now();
  const { result, exit, output } = await runCall(options, args, true);
  recordStep(options, step, exit, started, errorCodeOf(output));
  return result;
}

/**
 * Starts the program and settles on its exit. The timeout, the output cap and a failed start each settle the call once,
 * and stop the program if it is still running. The pipes are destroyed when the call settles, so a child that inherited
 * them cannot hold the call open. The output is returned only when keepOutput is set, and the caller then drops it.
 */
function runCall(options: HandsOptions, args: readonly string[], keepOutput: boolean): Promise<CallResult> {
  const program = options.binary.trim();
  return new Promise<CallResult>(resolve => {
    const child = start(program, args);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const kept: Buffer[] = [];
    const settle = (result: HandsResult, exit: number | HandsFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      const output = keepOutput ? Buffer.concat(kept) : undefined;
      kept.length = 0; // The captured output is handed to the caller once, and not kept here.
      resolve({ result, exit, output });
    };
    const failed = (failure: HandsFailure, reason: string): void => settle({ ok: false, failure, reason }, failure);

    if (!child) {
      failed('spawn_error', MESSAGES.spawn);
      return;
    }
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      failed('timeout', MESSAGES.timeout);
    }, options.timeoutMs ?? AGENT_DESKTOP_TIMEOUT_MS);

    let bytes = 0;
    const count = (chunk: Buffer): void => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        child.kill('SIGKILL');
        failed('output_limit', MESSAGES.output);
      }
    };
    // The envelope on stdout is matched as it arrives. Only the match position is kept, so the output is still discarded.
    let at = 0;
    let sawAmbiguous = false;
    const look = (chunk: Buffer): void => {
      for (let i = 0; i < chunk.length && !sawAmbiguous; i++) {
        while (at > 0 && chunk[i] !== AMBIGUOUS_CODE[at]) at = AMBIGUOUS_FAILURE[at - 1];
        if (chunk[i] === AMBIGUOUS_CODE[at]) at++;
        if (at === AMBIGUOUS_CODE.length) sawAmbiguous = true;
      }
    };
    child.stdout?.on('data', (chunk: Buffer) => {
      if (keepOutput && !settled) kept.push(chunk);
      count(chunk);
      look(chunk);
    });
    child.stderr?.on('data', count);
    child.once('error', () => failed('spawn_error', MESSAGES.spawn));
    const finish = (code: number | null): void => {
      if (code === 0) settle({ ok: true }, 0);
      else if (code === null) failed('signal', MESSAGES.signal);
      // The CLI exits 1 for every structured error, so the exit status alone cannot tell this one apart.
      else if (sawAmbiguous) settle({ ok: false, failure: 'ambiguous', reason: MESSAGES.ambiguous }, 'ambiguous');
      else settle({ ok: false, failure: 'exit', reason: `The agent-desktop program exited with status ${code}.` }, code);
    };
    // Output can still be in the pipes when the program exits, so the result waits briefly for them to close, and the
    // cap above applies to all of it. A child that inherited the pipes cannot hold the call past that drain.
    child.once('exit', code => {
      if (!settled) drain = setTimeout(() => finish(code), EXIT_DRAIN_MS);
    });
    child.once('close', code => finish(code));
  });
}
