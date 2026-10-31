import { spawn, type ChildProcess } from 'node:child_process';
import { statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { parseKeyChord, type Executor } from '@companyos/twin-core';

/**
 * The optional "hands" executor. An external agent-desktop program can take over the two steps that focus an app and
 * press a key chord. The program is not bundled. Its path is a setting that defaults to empty, and an empty path keeps
 * the built-in adapters, so nothing in this file runs unless a person sets the path.
 *
 * The program is called with a fixed argument array and never through a shell:
 *   <program> focus --app <name>
 *   <program> press --app <name> --shortcut <chord>
 * Exit status 0 is success. Any other status, a signal, a timeout or too much output is a failure. As with the built-in
 * adapters, the program brings the app forward and sends keys only once it is in front, and exits non-zero otherwise.
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

export type HandsStep = 'focus_app' | 'press_shortcut';
export type HandsFailure = 'blocked' | 'invalid_input' | 'exit' | 'signal' | 'timeout' | 'output_limit' | 'spawn_error';
export type HandsResult = { ok: true } | { ok: false; failure: HandsFailure; reason: string };

/**
 * What is kept about one call that started the program: the step, how it ended and how long it took. The application
 * name and the chord are never kept, and neither is any output.
 */
export interface HandsRecord {
  step: HandsStep;
  exit: number | HandsFailure;
  durationMs: number;
}

export interface HandsOptions {
  /** The program's path, as set in Settings. */
  binary: string;
  /** Called once for each call that started the program. */
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

/** True for a key chord in the canonical form the step schema accepts, such as "cmd+shift+k". */
export function isAllowedChord(chord: string): boolean {
  return CHORD_TEXT.test(chord) && parseKeyChord(chord) === chord;
}

/** Focuses an application through the program. Nothing starts unless the path is usable and the name is allowed. */
export async function focusWithAgentDesktop(options: HandsOptions, app: string): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  if (!isAllowedAppName(app)) return refused('invalid_input', MESSAGES.app);
  return runProgram(options, 'focus_app', ['focus', '--app', app]);
}

/** Presses a key chord in an application through the program. Nothing starts unless every input is allowed. */
export async function pressWithAgentDesktop(options: HandsOptions, app: string, shortcut: string): Promise<HandsResult> {
  const problem = agentDesktopProblem(options.binary);
  if (problem) return refused('blocked', problem);
  if (!isAllowedAppName(app)) return refused('invalid_input', MESSAGES.app);
  if (!isAllowedChord(shortcut)) return refused('invalid_input', MESSAGES.chord);
  return runProgram(options, 'press_shortcut', ['press', '--app', app, '--shortcut', shortcut]);
}

/**
 * The runner's executor when the program path is set. Focus and key steps go through the program. Frontmost-app checks,
 * links and files come from the built-in executor unchanged. While the path is unusable, both steps are blocked with the
 * reason before anyone is asked, and nothing starts.
 */
export function handsExecutor(base: Executor, options: HandsOptions): Executor {
  return {
    ...base,
    focusApp: async app => (await focusWithAgentDesktop(options, app)).ok,
    pressShortcut: async (app, shortcut) => (await pressWithAgentDesktop(options, app, shortcut)).ok,
    blockedReason: () => agentDesktopProblem(options.binary),
  };
}

function refused(failure: HandsFailure, reason: string): HandsResult {
  return { ok: false, failure, reason };
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
 * Starts the program and settles on its exit. The timeout, the output cap and a failed start each settle the call once,
 * and stop the program if it is still running. The pipes are destroyed when the call settles, so a child that inherited
 * them cannot hold the call open.
 */
function runProgram(options: HandsOptions, step: HandsStep, args: readonly string[]): Promise<HandsResult> {
  const started = Date.now();
  const program = options.binary.trim();
  return new Promise<HandsResult>(resolve => {
    const child = start(program, args);
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    let drain: NodeJS.Timeout | undefined;
    const settle = (result: HandsResult, exit: number | HandsFailure): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(drain);
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      try {
        options.record?.({ step, exit, durationMs: Date.now() - started });
      } catch {
        // The log is best effort. A failing log must not leave the call unsettled.
      }
      resolve(result);
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
    child.stdout?.on('data', count);
    child.stderr?.on('data', count);
    child.once('error', () => failed('spawn_error', MESSAGES.spawn));
    const finish = (code: number | null): void => {
      if (code === 0) settle({ ok: true }, 0);
      else if (code === null) failed('signal', MESSAGES.signal);
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
