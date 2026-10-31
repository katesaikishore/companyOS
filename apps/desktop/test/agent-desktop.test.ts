import { appendFileSync, chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Executor } from '@companyos/twin-core';
import {
  agentDesktopProblem,
  focusWithAgentDesktop,
  handsExecutor,
  isAllowedAppName,
  isAllowedChord,
  isAllowedWindowId,
  pressWithAgentDesktop,
  type HandsRecord,
} from '../src/main/agent-desktop';

/**
 * A stand-in for the agent-desktop program. Each start appends its argument list, as one JSON line, to the file named by
 * FAKE_AD_LOG, so a test can tell whether anything started. FAKE_AD_MODE "hang" never exits, and "flood" writes far more
 * than the output cap. "ambiguous" prints the AMBIGUOUS_TARGET envelope and exits 1. "ambiguous-split" sends the same
 * envelope in two pieces. "other-error" exits 1 with a different code whose message mentions the code. Otherwise it
 * exits with the status in FAKE_AD_EXIT, which defaults to 0.
 */
const FAKE_PROGRAM = [
  `#!${process.execPath}`,
  "const { appendFileSync } = require('node:fs');",
  "appendFileSync(process.env.FAKE_AD_LOG, JSON.stringify(process.argv.slice(2)) + '\\n');",
  "const mode = process.env.FAKE_AD_MODE || 'exit';",
  "if (mode === 'hang') setInterval(() => {}, 1000);",
  "else if (mode === 'flood') process.stdout.write('x'.repeat(200000));",
  "else if (mode === 'ambiguous') { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'AMBIGUOUS_TARGET', message: 'two windows match' } })); process.exitCode = 1; }",
  "else if (mode === 'ambiguous-split') { process.stdout.write('{\"ok\":false,\"error\":{\"code\":\"AMBIGUOUS_'); setTimeout(() => { process.stdout.write('TARGET\",\"message\":\"two windows match\"}}'); process.exitCode = 1; }, 100); }",
  "else if (mode === 'other-error') { process.stdout.write(JSON.stringify({ ok: false, error: { code: 'ACTION_FAILED', message: 'not AMBIGUOUS_TARGET here' } })); process.exitCode = 1; }",
  "else process.exitCode = Number(process.env.FAKE_AD_EXIT || '0');",
  '',
].join('\n');

const FAKE_KEYS = ['FAKE_AD_LOG', 'FAKE_AD_MODE', 'FAKE_AD_EXIT'];

let folder: string;
let program: string;
let logCount = 0;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-desktop-'));
  program = join(folder, 'agent-desktop-fake');
  writeFileSync(program, FAKE_PROGRAM);
  chmodSync(program, 0o755);
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

afterEach(() => {
  for (const key of FAKE_KEYS) delete process.env[key];
});

/** Points the fake at a new start log and sets how it behaves. Each option not given is cleared. Returns the log's path. */
function useFake(options: { mode?: 'hang' | 'flood' | 'ambiguous' | 'ambiguous-split' | 'other-error'; exit?: number } = {}): string {
  logCount++;
  const log = join(folder, `starts-${logCount}.log`);
  process.env.FAKE_AD_LOG = log;
  if (options.mode === undefined) delete process.env.FAKE_AD_MODE;
  else process.env.FAKE_AD_MODE = options.mode;
  if (options.exit === undefined) delete process.env.FAKE_AD_EXIT;
  else process.env.FAKE_AD_EXIT = String(options.exit);
  return log;
}

/** The argument lists the fake was started with, in order. Empty when it never started. */
function starts(log: string): string[][] {
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8')
    .trim()
    .split('\n')
    .map(line => JSON.parse(line) as string[]);
}

describe('the path check', () => {
  it('reports an empty path as off, with a reason', () => {
    expect(agentDesktopProblem('')).toMatch(/No agent-desktop program is set/);
    expect(agentDesktopProblem('   ')).toMatch(/No agent-desktop program is set/);
  });

  it('refuses a relative path, a missing file, a folder and a path with control characters', () => {
    expect(agentDesktopProblem('agent-desktop-fake')).toMatch(/absolute/);
    expect(agentDesktopProblem(join(folder, 'missing'))).toMatch(/No program file/);
    expect(agentDesktopProblem(folder)).toMatch(/No program file/);
    expect(agentDesktopProblem(`${program}\u0007x`)).toMatch(/not valid/);
  });

  it('accepts an absolute path to an existing file', () => {
    expect(agentDesktopProblem(program)).toBeUndefined();
  });
});

describe('an empty or unusable path', () => {
  it('blocks both steps with a reason and never starts anything', async () => {
    const log = useFake();
    const record = vi.fn<(entry: HandsRecord) => void>();
    for (const binary of ['', 'agent-desktop-fake', join(folder, 'missing')]) {
      expect(await focusWithAgentDesktop({ binary, record }, 'Microsoft Excel')).toMatchObject({ ok: false, failure: 'blocked' });
      expect(await pressWithAgentDesktop({ binary, record }, 'Microsoft Excel', 'cmd+shift+k')).toMatchObject({
        ok: false,
        failure: 'blocked',
      });
    }
    expect(starts(log)).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('gives the executor a block reason, and its steps report failure without starting anything', async () => {
    const log = useFake();
    // The built-in focus succeeds here, so a fall-through to it would show as a pass.
    const base: Executor = { focusApp: async () => true, frontmostApp: async () => undefined };
    const executor = handsExecutor(base, { binary: '' }, 'darwin');
    expect(executor.blockedReason?.('focus_app')).toMatch(/No agent-desktop program is set/);
    expect(executor.blockedReason?.('press_shortcut')).toMatch(/No agent-desktop program is set/);
    expect(await executor.focusApp('Microsoft Excel')).toBe(false);
    expect(await executor.pressShortcut?.('Microsoft Excel', 'cmd+shift+k')).toBe(false);
    expect(starts(log)).toEqual([]);
  });
});

describe('input checks', () => {
  it('allows the application names and key chords the step schema allows', () => {
    for (const app of ['Microsoft Excel', 'Google Chrome', 'libreoffice-calc', 'Visual Studio Code', 'iTerm2', 'Adobe Photoshop 2025 (Beta)']) {
      expect(isAllowedAppName(app)).toBe(true);
    }
    for (const chord of ['cmd+shift+k', 'ctrl+alt+delete', 'cmd+f5']) {
      expect(isAllowedChord(chord)).toBe(true);
    }
  });

  it('rejects names and chords outside the allowlist before anything starts', async () => {
    const log = useFake();
    const record = vi.fn<(entry: HandsRecord) => void>();
    const apps = ['-x', '--help', 'Excel; rm -rf /', 'Excel\nOther', '$(id)', '"Excel"', 'Excel/../x', '', ' Excel', 'Excel ', 'a'.repeat(101)];
    for (const app of apps) {
      expect(isAllowedAppName(app)).toBe(false);
      expect(await focusWithAgentDesktop({ binary: program, record }, app)).toMatchObject({ ok: false, failure: 'invalid_input' });
      expect(await pressWithAgentDesktop({ binary: program, record }, app, 'cmd+shift+k')).toMatchObject({
        ok: false,
        failure: 'invalid_input',
      });
    }
    const chords = ['k', 'cmd+', 'cmd+k+k', 'shift+cmd+k', 'cmd+shift+K', 'cmd+shift+k; rm -rf /', 'cmd+shift+k\n', '+k', 'cmd+f13', 'cmd+alt+ctrl+cmd+k', 'cmd+$'];
    for (const chord of chords) {
      expect(isAllowedChord(chord)).toBe(false);
      expect(await pressWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', chord)).toMatchObject({
        ok: false,
        failure: 'invalid_input',
      });
    }
    expect(starts(log)).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });
});

describe('a good call', () => {
  it('starts the program with the expected argument list and reports success', async () => {
    const log = useFake();
    const record = vi.fn<(entry: HandsRecord) => void>();
    expect(await focusWithAgentDesktop({ binary: program, record }, 'Microsoft Excel')).toEqual({ ok: true });
    expect(await pressWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', 'cmd+shift+k')).toEqual({ ok: true });
    expect(starts(log)).toEqual([
      ['focus-window', '--app', 'Microsoft Excel'],
      ['focus-window', '--app', 'Microsoft Excel'],
      ['press', 'cmd+shift+k', '--app', 'Microsoft Excel'],
    ]);
    expect(record.mock.calls.map(([entry]) => [entry.step, entry.exit])).toEqual([
      ['focus_app', 0],
      ['press_shortcut', 0],
      ['press_shortcut', 0],
    ]);
  });
});

describe('a window target', () => {
  const WINDOW = 'w-1.0-org-a11y-atspi-accessible-2';

  it('names the window with --window-id in place of --app, for focus and for press', async () => {
    const log = useFake();
    const record = vi.fn<(entry: HandsRecord) => void>();
    expect(await focusWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', WINDOW)).toEqual({ ok: true });
    expect(await pressWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', 'cmd+shift+k', WINDOW)).toEqual({ ok: true });
    expect(starts(log)).toEqual([
      ['focus-window', '--window-id', WINDOW],
      ['focus-window', '--window-id', WINDOW],
      ['press', 'cmd+shift+k', '--window-id', WINDOW],
    ]);
    expect(starts(log).flat()).not.toContain('--app');
  });

  it('allows the window IDs the list-windows output uses and nothing with a leading dash, a space or a bad character', () => {
    for (const id of [WINDOW, 'a'.repeat(120), 'a:b_c.d-1']) expect(isAllowedWindowId(id)).toBe(true);
    for (const id of ['-w', '--help', 'w 1', '', ' w1', 'w1 ', 'a'.repeat(121), 'w\n1', 'w/1', '$(id)', 'w,1', 'w"1']) {
      expect(isAllowedWindowId(id)).toBe(false);
    }
  });

  it('refuses a bad window ID as invalid input before anything starts', async () => {
    const log = useFake();
    const record = vi.fn<(entry: HandsRecord) => void>();
    for (const id of ['-w', '--help', 'w 1', '', 'a'.repeat(121), 'w\n1', '$(id)']) {
      expect(await focusWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', id)).toMatchObject({
        ok: false,
        failure: 'invalid_input',
      });
      expect(await pressWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', 'cmd+shift+k', id)).toMatchObject({
        ok: false,
        failure: 'invalid_input',
      });
    }
    // The app name is still checked when a window ID is given, since it is used for logs.
    expect(await focusWithAgentDesktop({ binary: program, record }, '-x', WINDOW)).toMatchObject({ ok: false, failure: 'invalid_input' });
    expect(starts(log)).toEqual([]);
    expect(record).not.toHaveBeenCalled();
  });

  it('reports AMBIGUOUS_TARGET in the envelope as ambiguous, with the reason, and records only the step, the status and the duration', async () => {
    const log = useFake({ mode: 'ambiguous' });
    const record = vi.fn<(entry: HandsRecord) => void>();
    expect(await focusWithAgentDesktop({ binary: program, record }, 'Microsoft Excel')).toEqual({
      ok: false,
      failure: 'ambiguous',
      reason: 'More than one window of this app is open. Choose a window, then try again.',
    });
    expect(starts(log)).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry).toEqual({ step: 'focus_app', exit: 'ambiguous', durationMs: expect.any(Number) });
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'exit', 'step']);
    expect(JSON.stringify(entry)).not.toMatch(/AMBIGUOUS|two windows|Microsoft/);
  });

  it('finds the code when the envelope arrives in two pieces', async () => {
    useFake({ mode: 'ambiguous-split' });
    expect(await pressWithAgentDesktop({ binary: program }, 'Microsoft Excel', 'cmd+shift+k', WINDOW)).toMatchObject({
      ok: false,
      failure: 'ambiguous',
    });
  });

  it('keeps a different code, or the code named in a message, as a plain exit failure', async () => {
    useFake({ mode: 'other-error' });
    expect(await focusWithAgentDesktop({ binary: program }, 'Microsoft Excel')).toMatchObject({ ok: false, failure: 'exit', reason: 'The agent-desktop program exited with status 1.' });
  });
});

describe('a failed call', () => {
  it('turns a non-zero exit into a failure and records only the step, the status and the duration', async () => {
    const log = useFake({ exit: 3 });
    const record = vi.fn<(entry: HandsRecord) => void>();
    expect(await focusWithAgentDesktop({ binary: program, record }, 'Microsoft Excel')).toMatchObject({ ok: false, failure: 'exit' });
    expect(starts(log)).toHaveLength(1);
    expect(record).toHaveBeenCalledTimes(1);
    const entry = record.mock.calls[0][0];
    expect(entry).toEqual({ step: 'focus_app', exit: 3, durationMs: expect.any(Number) });
    expect(Object.keys(entry).sort()).toEqual(['durationMs', 'exit', 'step']);
    expect(JSON.stringify(entry)).not.toMatch(/Excel/);
  });

  it('makes the executor step report false on a non-zero exit', async () => {
    useFake({ exit: 1 });
    const executor = handsExecutor({ focusApp: async () => true, frontmostApp: async () => undefined }, { binary: program }, 'darwin');
    expect(await executor.pressShortcut?.('Microsoft Excel', 'cmd+shift+k')).toBe(false);
    expect(await executor.focusApp('Microsoft Excel')).toBe(false);
  });

  it('reports a program that cannot be started as a spawn failure', async () => {
    const notExecutable = join(folder, 'not-executable');
    writeFileSync(notExecutable, FAKE_PROGRAM);
    chmodSync(notExecutable, 0o644);
    const record = vi.fn<(entry: HandsRecord) => void>();
    expect(await focusWithAgentDesktop({ binary: notExecutable, record }, 'Microsoft Excel')).toMatchObject({
      ok: false,
      failure: 'spawn_error',
    });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ step: 'focus_app', exit: 'spawn_error' }));
  });

  it('stops a call that runs past its timeout', async () => {
    const log = useFake({ mode: 'hang' });
    const record = vi.fn<(entry: HandsRecord) => void>();
    const started = Date.now();
    const result = await focusWithAgentDesktop({ binary: program, record, timeoutMs: 300 }, 'Microsoft Excel');
    expect(result).toMatchObject({ ok: false, failure: 'timeout' });
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(record).toHaveBeenCalledWith({ step: 'focus_app', exit: 'timeout', durationMs: expect.any(Number) });
    expect(starts(log)).toHaveLength(1);
  });

  it('stops a program that writes more than the output cap', async () => {
    useFake({ mode: 'flood' });
    const record = vi.fn<(entry: HandsRecord) => void>();
    const result = await pressWithAgentDesktop({ binary: program, record }, 'Microsoft Excel', 'cmd+shift+k');
    expect(result).toMatchObject({ ok: false, failure: 'output_limit' });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ step: 'press_shortcut', exit: 'output_limit' }));
  });
});

describe('an executor with a usable path', () => {
  it('sends focus and key steps through the program and leaves the rest to the built-in executor', async () => {
    const log = useFake();
    // The built-in focus and press throw, so any call that reaches them fails the test.
    const base: Executor = {
      focusApp: async () => {
        throw new Error('the built-in focus must not run');
      },
      frontmostApp: async () => 'microsoft excel',
      pressShortcut: async () => {
        throw new Error('the built-in press must not run');
      },
    };
    const executor = handsExecutor(base, { binary: program }, 'darwin');
    expect(executor.blockedReason?.('focus_app')).toBeUndefined();
    expect(await executor.focusApp('Microsoft Excel')).toBe(true);
    expect(await executor.pressShortcut?.('Microsoft Excel', 'cmd+shift+k')).toBe(true);
    expect(await executor.frontmostApp()).toBe('microsoft excel');
    expect(starts(log).map(args => args[0])).toEqual(['focus-window', 'focus-window', 'press']);
  });

  it('keeps key presses on Linux with the built-in adapter, even when the path is set, and still focuses through the program', async () => {
    const log = useFake();
    let builtInPresses = 0;
    const base: Executor = {
      focusApp: async () => {
        throw new Error('the built-in focus must not run on this path');
      },
      frontmostApp: async () => undefined,
      pressShortcut: async () => {
        builtInPresses++;
        return true;
      },
    };
    const executor = handsExecutor(base, { binary: program }, 'linux');
    expect(executor.blockedReason?.('press_shortcut')).toBeUndefined();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'cmd+shift+k')).toBe(true);
    expect(builtInPresses).toBe(1);
    expect(starts(log)).toEqual([]);
    expect(await executor.focusApp('Microsoft Excel')).toBe(true);
    expect(starts(log).map(args => args[0])).toEqual(['focus-window']);
  });
});
