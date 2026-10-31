import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { choosePlatform, executorFor } from '../src/main/platform';

/**
 * A stand-in for xdotool. Every call is appended to FAKE_XDO_LOG as one line. FAKE_XDO_ACTIVE is the window the active
 * window reports. FAKE_XDO_MATCH lists the windows the class search finds. FAKE_XDO_ACTIVATE "fail" makes the activation
 * step fail.
 */
const FAKE_XDOTOOL = [
  '#!/bin/bash',
  'echo "$*" >> "$FAKE_XDO_LOG"',
  'case "$1" in',
  '  version) exit 0 ;;',
  '  getactivewindow) echo "$FAKE_XDO_ACTIVE"; exit 0 ;;',
  '  search)',
  '    if [[ "$*" == *windowactivate* ]]; then [ "$FAKE_XDO_ACTIVATE" = fail ] && exit 1; exit 0; fi',
  '    [ -z "$FAKE_XDO_MATCH" ] && exit 1',
  '    echo "$FAKE_XDO_MATCH"; exit 0 ;;',
  '  key) exit 0 ;;',
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n');

/**
 * A stand-in for xprop. It prints FAKE_XPROP_LINE as the WM_CLASS line, the way the real tool writes it: quotes and
 * backslashes inside a string are escaped with a backslash.
 */
const FAKE_XPROP = [
  '#!/bin/bash',
  'if [ "$1" = "-version" ]; then echo "xprop 1.2.6"; exit 0; fi',
  'printf \'%s\\n\' "$FAKE_XPROP_LINE"',
  '',
].join('\n');

const DEFAULT_WM_CLASS = 'WM_CLASS(STRING) = "testapp.py", "Testapp.py"';

const LINUX = process.platform === 'linux';
let folder = '';
const saved: Record<string, string | undefined> = {};
const KEYS = [
  'PATH',
  'DISPLAY',
  'XDG_SESSION_TYPE',
  'COMPANYOS_TEST_FAKE_PLATFORM',
  'FAKE_XDO_LOG',
  'FAKE_XDO_ACTIVE',
  'FAKE_XDO_MATCH',
  'FAKE_XDO_ACTIVATE',
  'FAKE_XPROP_LINE',
];

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  folder = mkdtempSync(join(tmpdir(), 'linux-press-'));
  writeFileSync(join(folder, 'xdotool'), FAKE_XDOTOOL);
  chmodSync(join(folder, 'xdotool'), 0o755);
  writeFileSync(join(folder, 'xprop'), FAKE_XPROP);
  chmodSync(join(folder, 'xprop'), 0o755);
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

afterAll(() => {
  rmSync(folder, { recursive: true, force: true });
});

/** Points the fake at a new log and sets what it reports. Returns the path of the log. */
function useFake(options: { active: string; match: string; activate?: 'fail'; wmClass?: string }): string {
  const log = join(folder, `calls-${Math.random().toString(36).slice(2)}.log`);
  process.env.PATH = `${folder}:${saved.PATH ?? ''}`;
  process.env.DISPLAY = ':0';
  process.env.FAKE_XDO_LOG = log;
  process.env.FAKE_XDO_ACTIVE = options.active;
  process.env.FAKE_XDO_MATCH = options.match;
  process.env.FAKE_XPROP_LINE = options.wmClass ?? DEFAULT_WM_CLASS;
  if (options.activate) process.env.FAKE_XDO_ACTIVATE = options.activate;
  else delete process.env.FAKE_XDO_ACTIVATE;
  delete process.env.XDG_SESSION_TYPE;
  delete process.env.COMPANYOS_TEST_FAKE_PLATFORM;
  return log;
}

function calls(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
}

async function linuxExecutor() {
  const choice = await choosePlatform();
  if (!choice.platform) throw new Error(`no X11 platform: ${choice.detail}`);
  return executorFor(choice.platform);
}

describe.skipIf(!LINUX)('X11 frontmost app', () => {
  it('reads the class of the active window from its WM_CLASS, since xdotool here has no getwindowclassname', async () => {
    useFake({ active: '4194307', match: '4194307' });
    const executor = await linuxExecutor();
    expect(await executor.frontmostApp()).toBe('Testapp.py');
  });

  it('reports no class for a WM_CLASS with one string, since xdotool --class does not match that string', async () => {
    useFake({ active: '4194307', match: '4194307', wmClass: 'WM_CLASS(STRING) = "solo"' });
    const executor = await linuxExecutor();
    expect(await executor.frontmostApp()).toBeUndefined();
  });

  it('unescapes a quote in the class, so it is the name xdotool matches', async () => {
    useFake({ active: '4194307', match: '4194307', wmClass: 'WM_CLASS(STRING) = "inst", "My\\"App"' });
    const executor = await linuxExecutor();
    expect(await executor.frontmostApp()).toBe('My"App');
  });

  it('unescapes a backslash in the class', async () => {
    useFake({ active: '4194307', match: '4194307', wmClass: 'WM_CLASS(STRING) = "inst", "back\\\\slash"' });
    const executor = await linuxExecutor();
    expect(await executor.frontmostApp()).toBe('back\\slash');
  });
});

describe.skipIf(!LINUX)('X11 key press through xdotool', () => {
  it('activates the app, confirms it is the active window, then sends the chord as one argument', async () => {
    const log = useFake({ active: '4194307', match: '4194307' });
    const executor = await linuxExecutor();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'cmd+shift+k')).toBe(true);
    expect(calls(log)).toEqual([
      'version',
      'search --onlyvisible --class ^Microsoft Excel$ windowactivate --sync',
      'getactivewindow',
      'search --onlyvisible --class ^Microsoft Excel$',
      'key --clearmodifiers ctrl+shift+k',
    ]);
  });

  it('sends nothing when another window is active', async () => {
    const log = useFake({ active: '999', match: '4194307' });
    const executor = await linuxExecutor();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'ctrl+a')).toBe(false);
    expect(calls(log).some(line => line.startsWith('key'))).toBe(false);
  });

  it('sends nothing when the app has no visible window', async () => {
    const log = useFake({ active: '999', match: '' });
    const executor = await linuxExecutor();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'ctrl+a')).toBe(false);
    expect(calls(log).some(line => line.startsWith('key'))).toBe(false);
  });

  it('sends nothing when the app cannot be brought forward', async () => {
    const log = useFake({ active: '4194307', match: '4194307', activate: 'fail' });
    const executor = await linuxExecutor();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'ctrl+a')).toBe(false);
    expect(calls(log).some(line => line.startsWith('key'))).toBe(false);
  });

  it('refuses a chord the grammar does not allow before xdotool is run for the keys', async () => {
    const log = useFake({ active: '4194307', match: '4194307' });
    const executor = await linuxExecutor();
    expect(await executor.pressShortcut?.('Microsoft Excel', 'notakey')).toBe(false);
    expect(calls(log).some(line => line.startsWith('search') || line.startsWith('key'))).toBe(false);
  });

  it('escapes the app name, so a name with regex characters only matches that name', async () => {
    const log = useFake({ active: '4194307', match: '4194307' });
    const executor = await linuxExecutor();
    await executor.pressShortcut?.('Node (LTS).app', 'ctrl+a');
    expect(calls(log)[1]).toBe('search --onlyvisible --class ^Node \\(LTS\\)\\.app$ windowactivate --sync');
  });
});
