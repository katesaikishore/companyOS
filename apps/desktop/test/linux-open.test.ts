import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  AutomationSchema,
  StepRefusedError,
  runAutomation,
  type Executor,
  type PolicyContext,
  type Step,
} from '@companyos/twin-core';
import {
  applicationDirs,
  execPrograms,
  execTakes,
  loadDesktopEntries,
  parseDesktopEntry,
  resolveDesktopEntry,
  splitExec,
  type DesktopEntry,
} from '../src/main/linux-open';
import { choosePlatform, executorFor, launchDetached } from '../src/main/platform';

const LINUX = process.platform === 'linux';

/** A stand-in for xdotool, as in linux-press.test.ts. Each call is one line in FAKE_XDO_LOG. */
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
  '  *) exit 1 ;;',
  'esac',
  '',
].join('\n');

const FAKE_XPROP = [
  '#!/bin/bash',
  'if [ "$1" = "-version" ]; then echo "xprop 1.2.6"; exit 0; fi',
  'printf \'%s\\n\' "$FAKE_XPROP_LINE"',
  '',
].join('\n');

/**
 * A stand-in for `gio`. `gio help launch` succeeds, which is how the adapter finds out launch exists. Any other call
 * is one line in FAKE_GIO_LOG with each argument followed by a tab. FAKE_GIO_EXIT is the exit status. FAKE_GIO_BACKGROUND
 * starts a process that outlives gio, as a launched app does.
 */
const FAKE_GIO = [
  '#!/bin/bash',
  'if [ "$1" = "help" ] && [ "$2" = "launch" ]; then exit 0; fi',
  'printf \'%s\\t\' "$@" >> "$FAKE_GIO_LOG"; echo >> "$FAKE_GIO_LOG"',
  '[ -n "$FAKE_GIO_BACKGROUND" ] && (sleep "$FAKE_GIO_BACKGROUND" &)',
  'exit "${FAKE_GIO_EXIT:-0}"',
  '',
].join('\n');

const KEYS = [
  'PATH',
  'DISPLAY',
  'XDG_SESSION_TYPE',
  'XDG_DATA_HOME',
  'XDG_DATA_DIRS',
  'COMPANYOS_TEST_FAKE_PLATFORM',
  'FAKE_XDO_LOG',
  'FAKE_XDO_ACTIVE',
  'FAKE_XDO_MATCH',
  'FAKE_XDO_ACTIVATE',
  'FAKE_XPROP_LINE',
  'FAKE_GIO_LOG',
  'FAKE_GIO_EXIT',
  'FAKE_GIO_BACKGROUND',
  'APP_LOG',
  'MARKER',
];
const saved: Record<string, string | undefined> = {};
let root = '';
let tools = '';
let fakeGio = '';
let userData = '';
let systemData = '';
let files = '';

function script(dir: string, name: string, body: string): string {
  const path = join(dir, name);
  writeFileSync(path, body);
  chmodSync(path, 0o755);
  return path;
}

beforeAll(() => {
  for (const key of KEYS) saved[key] = process.env[key];
  root = realpathSync(mkdtempSync(join(tmpdir(), 'linux-open-')));
  tools = join(root, 'tools');
  fakeGio = join(root, 'fake-gio');
  userData = join(root, 'user-data');
  systemData = join(root, 'system-data');
  files = join(root, 'files');
  for (const dir of [tools, fakeGio, files, join(userData, 'applications'), join(systemData, 'applications')]) {
    mkdirSync(dir, { recursive: true });
  }
  script(tools, 'xdotool', FAKE_XDOTOOL);
  script(tools, 'xprop', FAKE_XPROP);
  script(fakeGio, 'gio', FAKE_GIO);
});

afterEach(() => {
  for (const key of KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
  for (const dir of [userData, systemData]) {
    rmSync(join(dir, 'applications'), { recursive: true, force: true });
    mkdirSync(join(dir, 'applications'), { recursive: true });
  }
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const BROWSER = ['Type=Application', 'Name=Firefox Web Browser', 'Exec=/usr/bin/firefox %u', 'StartupWMClass=firefox',
  'MimeType=text/html;x-scheme-handler/http;x-scheme-handler/https;'];
const EDITOR = ['Type=Application', 'Name=Text Editor', 'Exec=/usr/bin/editor %F'];

/** Writes one desktop entry into the system or the user applications directory, and returns its path. */
function entry(id: string, lines: readonly string[], where: 'system' | 'user' = 'system'): string {
  const path = join(where === 'system' ? systemData : userData, 'applications', `${id}.desktop`);
  writeFileSync(path, ['[Desktop Entry]', ...lines, ''].join('\n'));
  return path;
}

type GioKind = 'fake' | 'real' | 'none';

/** Sets up PATH, the data directories and the logs. Returns the three log paths. */
function useDesktop(options: { gio: GioKind; wmClass?: string; active?: string; activate?: 'fail' }) {
  const id = Math.random().toString(36).slice(2);
  const logs = { gio: join(root, `gio-${id}.log`), xdo: join(root, `xdo-${id}.log`), app: join(root, `app-${id}.log`) };
  const path = options.gio === 'fake' ? [fakeGio, tools] : options.gio === 'real' ? [tools] : [tools];
  // With no gio, PATH holds only the fake X11 tools, which are bash scripts that use no other program.
  process.env.PATH = options.gio === 'none' ? path.join(':') : `${path.join(':')}:${saved.PATH ?? ''}`;
  process.env.DISPLAY = ':0';
  process.env.XDG_DATA_HOME = userData;
  process.env.XDG_DATA_DIRS = systemData;
  process.env.FAKE_GIO_LOG = logs.gio;
  process.env.FAKE_XDO_LOG = logs.xdo;
  process.env.FAKE_XDO_ACTIVE = options.active ?? '100';
  process.env.FAKE_XDO_MATCH = '100';
  process.env.FAKE_XPROP_LINE = options.wmClass ?? 'WM_CLASS(STRING) = "Navigator", "firefox"';
  process.env.APP_LOG = logs.app;
  delete process.env.FAKE_GIO_EXIT;
  delete process.env.FAKE_GIO_BACKGROUND;
  if (options.activate) process.env.FAKE_XDO_ACTIVATE = options.activate;
  else delete process.env.FAKE_XDO_ACTIVATE;
  delete process.env.XDG_SESSION_TYPE;
  delete process.env.COMPANYOS_TEST_FAKE_PLATFORM;
  return logs;
}

async function linuxExecutor(): Promise<Executor> {
  const choice = await choosePlatform();
  if (!choice.platform) throw new Error(`no X11 platform: ${choice.detail}`);
  return executorFor(choice.platform);
}

function lines(log: string): string[] {
  return existsSync(log) ? readFileSync(log, 'utf8').split('\n').filter(Boolean) : [];
}

/** The launch calls the fake gio saw, each as its list of arguments. */
function launches(log: string): string[][] {
  return lines(log).map(line => line.split('\t').slice(0, -1));
}

/** The message of the refusal an open step throws, or undefined when it returned a value. */
async function refusal(promise: Promise<boolean> | undefined): Promise<string | undefined> {
  try {
    await promise;
    return undefined;
  } catch (error) {
    if (error instanceof StepRefusedError) return error.message;
    throw error;
  }
}

describe('splitExec and execPrograms', () => {
  it('splits on spaces and keeps a quoted argument whole', () => {
    expect(splitExec('/usr/bin/app --name "My App" %u')).toEqual(['/usr/bin/app', '--name', 'My App', '%u']);
    expect(splitExec('"/opt/My App/run" %f')).toEqual(['/opt/My App/run', '%f']);
  });

  it('reads a backslash as an escape, inside quotes or out', () => {
    expect(splitExec('app a\\ b "c\\"d"')).toEqual(['app', 'a b', 'c"d']);
  });

  it('lists the first argument, and after env every argument that is not an option or an assignment', () => {
    expect(execPrograms('/usr/bin/firefox %u')).toEqual(['/usr/bin/firefox']);
    expect(execPrograms('env BAMF_DESKTOP_FILE_HINT=/x.desktop /snap/bin/firefox %u')).toEqual(['env', '/snap/bin/firefox']);
    expect(execPrograms('/usr/bin/env -u FOO sh -c "x"')).toEqual(['/usr/bin/env', 'FOO', 'sh', 'x']);
    expect(execPrograms('')).toEqual([]);
  });
});

describe('execTakes', () => {
  it('needs %u or %U for a web address, and any of %f %F %u %U for a file', () => {
    expect(execTakes('app %u', { kind: 'url', scheme: 'https' })).toBe(true);
    expect(execTakes('app %U', { kind: 'url', scheme: 'https' })).toBe(true);
    expect(execTakes('app %f', { kind: 'url', scheme: 'https' })).toBe(false);
    expect(execTakes('app %F', { kind: 'file' })).toBe(true);
    expect(execTakes('app %f', { kind: 'file' })).toBe(true);
    expect(execTakes('app %u', { kind: 'file' })).toBe(true);
  });

  it('does not count a code that is a literal percent sign, or an app with no code', () => {
    expect(execTakes('app 100%%u', { kind: 'file' })).toBe(false);
    expect(execTakes('app --new-window', { kind: 'file' })).toBe(false);
    expect(execTakes('app %i %c %k', { kind: 'file' })).toBe(false);
  });
});

describe('parseDesktopEntry', () => {
  const parse = (...lines: string[]) => parseDesktopEntry('app', '/x/app.desktop', ['[Desktop Entry]', ...lines].join('\n'));

  it('reads the fields it needs and nothing else', () => {
    expect(parse(...BROWSER)).toEqual({
      id: 'app',
      file: '/x/app.desktop',
      name: 'Firefox Web Browser',
      wmClass: 'firefox',
      exec: '/usr/bin/firefox %u',
      mimeTypes: ['text/html', 'x-scheme-handler/http', 'x-scheme-handler/https'],
    });
  });

  it('reads only the Desktop Entry group, skips comments and ignores a key with a locale', () => {
    const text = [
      '# a comment',
      '[Desktop Entry]',
      'Type=Application',
      'Name=Real',
      'Name[de]=Echt',
      'Exec=/usr/bin/real %f',
      '[Desktop Action new-window]',
      'Name=Other',
      'Exec=/usr/bin/other',
    ].join('\n');
    const parsed = parseDesktopEntry('real', '/x/real.desktop', text);
    expect(parsed?.name).toBe('Real');
    expect(parsed?.exec).toBe('/usr/bin/real %f');
  });

  it('drops entries that are not applications, are hidden, or are not shown in menus', () => {
    expect(parse('Type=Link', 'Name=A', 'Exec=/usr/bin/a %f')).toBeUndefined();
    expect(parse('Type=Application', 'Hidden=true', 'Exec=/usr/bin/a %f')).toBeUndefined();
    expect(parse('Type=Application', 'NoDisplay=true', 'Exec=/usr/bin/a %f')).toBeUndefined();
    expect(parse('Type=Application', 'Name=A')).toBeUndefined();
  });

  it('drops terminal programs and terminal emulators', () => {
    expect(parse('Type=Application', 'Terminal=true', 'Exec=/usr/bin/vim %f')).toBeUndefined();
    expect(parse('Type=Application', 'Categories=System;TerminalEmulator;', 'Exec=/usr/bin/xterm %f')).toBeUndefined();
  });

  it('drops an entry whose Exec starts a shell or an interpreter, however it is spelled', () => {
    expect(parse('Type=Application', 'Exec=sh -c "app %f"')).toBeUndefined();
    expect(parse('Type=Application', 'Exec=/bin/bash -c "app %f"')).toBeUndefined();
    expect(parse('Type=Application', 'Exec="/bin/sh" -c "app %f"')).toBeUndefined();
    expect(parse('Type=Application', 'Exec=env FOO=1 sh -c "app %f"')).toBeUndefined();
    expect(parse('Type=Application', 'Exec=python3 /opt/app/run.py %f')).toBeUndefined();
    expect(parse('Type=Application', 'Exec=/usr/bin/zsh %f')).toBeUndefined();
  });

  it('keeps an app that is started through env, as snap and flatpak wrappers are', () => {
    expect(parse('Type=Application', 'Exec=env BAMF=1 /snap/bin/firefox %u')?.exec).toBe('env BAMF=1 /snap/bin/firefox %u');
    expect(parse('Type=Application', 'Exec=/usr/bin/flatpak run org.mozilla.firefox @@u %u @@')).toBeDefined();
  });
});

describe('resolveDesktopEntry', () => {
  const make = (id: string, fields: Partial<DesktopEntry> = {}): DesktopEntry => ({
    id,
    file: `/apps/${id}.desktop`,
    exec: `/usr/bin/${id} %u`,
    mimeTypes: ['x-scheme-handler/https'],
    ...fields,
  });
  const https = { kind: 'url', scheme: 'https' } as const;

  it('matches the window class, the desktop file ID or the Name, ignoring case and spacing', () => {
    const entries = [make('org.example.web', { wmClass: 'Example-Web' }), make('chromium', { name: 'Chromium Web Browser' })];
    expect(resolveDesktopEntry('example-web', entries, https)).toMatchObject({ ok: true, entry: { id: 'org.example.web' } });
    expect(resolveDesktopEntry('  CHROMIUM ', entries, https)).toMatchObject({ ok: true, entry: { id: 'chromium' } });
    expect(resolveDesktopEntry('chromium  web   browser', entries, https)).toMatchObject({ ok: true, entry: { id: 'chromium' } });
  });

  it('prefers the window class over the ID, and the ID over the Name', () => {
    const byClass = make('a-one', { wmClass: 'shared' });
    const byId = make('shared');
    const byName = make('c-three', { name: 'shared' });
    expect(resolveDesktopEntry('shared', [byName, byId, byClass], https)).toMatchObject({ entry: { id: 'a-one' } });
    expect(resolveDesktopEntry('shared', [byName, byId], https)).toMatchObject({ entry: { id: 'shared' } });
    expect(resolveDesktopEntry('shared', [byName], https)).toMatchObject({ entry: { id: 'c-three' } });
  });

  it('refuses a name that two entries share at the strongest level', () => {
    const entries = [make('one', { wmClass: 'twin' }), make('two', { wmClass: 'twin' })];
    expect(resolveDesktopEntry('twin', entries, https)).toEqual({ ok: false, reason: 'ambiguous' });
  });

  it('does not let a weaker match break a tie, and does not count an entry that cannot take the address', () => {
    const noHandler = make('web', { wmClass: 'web', mimeTypes: ['text/html'] });
    const handler = make('web-two', { name: 'web' });
    expect(resolveDesktopEntry('web', [noHandler, handler], https)).toMatchObject({ ok: true, entry: { id: 'web-two' } });
  });

  it('reports an app that exists but cannot take the target, and one that is not installed', () => {
    const noHandler = make('viewer', { mimeTypes: ['text/html'] });
    const noCode = make('plain', { exec: '/usr/bin/plain --new' });
    expect(resolveDesktopEntry('viewer', [noHandler], https)).toEqual({ ok: false, reason: 'cannot_open' });
    expect(resolveDesktopEntry('plain', [noCode], { kind: 'file' })).toEqual({ ok: false, reason: 'cannot_open' });
    expect(resolveDesktopEntry('missing', [noHandler], https)).toEqual({ ok: false, reason: 'not_found' });
    expect(resolveDesktopEntry('   ', [noHandler], https)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('needs the handler for the exact scheme in the address', () => {
    const httpsOnly = make('secure');
    expect(resolveDesktopEntry('secure', [httpsOnly], { kind: 'url', scheme: 'http' })).toEqual({ ok: false, reason: 'cannot_open' });
  });

  it('does not match part of a name', () => {
    expect(resolveDesktopEntry('fire', [make('firefox')], https)).toEqual({ ok: false, reason: 'not_found' });
  });
});

describe.skipIf(!LINUX)('loadDesktopEntries', () => {
  it('reads the user directory before the system directories and takes each ID once', () => {
    useDesktop({ gio: 'fake' });
    entry('browser', ['Type=Application', 'Name=System copy', 'Exec=/usr/bin/browser %u']);
    const userPath = entry('browser', ['Type=Application', 'Name=User copy', 'Exec=/home/me/browser %u'], 'user');
    const entries = loadDesktopEntries(process.env);
    expect(entries.filter(item => item.id === 'browser')).toEqual([
      { id: 'browser', file: userPath, name: 'User copy', exec: '/home/me/browser %u', mimeTypes: [] },
    ]);
  });

  it('lets a hidden user entry remove the system entry with the same ID', () => {
    useDesktop({ gio: 'fake' });
    entry('removed', ['Type=Application', 'Name=Gone', 'Exec=/usr/bin/gone %u']);
    entry('removed', ['Type=Application', 'Hidden=true', 'Exec=/usr/bin/gone %u'], 'user');
    expect(loadDesktopEntries(process.env).some(item => item.id === 'removed')).toBe(false);
  });

  it('ignores a data directory that is not absolute, and a file that is not a .desktop file', () => {
    useDesktop({ gio: 'fake' });
    process.env.XDG_DATA_DIRS = `relative/dir::${systemData}`;
    writeFileSync(join(systemData, 'applications', 'notes.txt'), '[Desktop Entry]\nType=Application\nExec=/usr/bin/x %f\n');
    entry('ok', ['Type=Application', 'Name=Ok', 'Exec=/usr/bin/ok %f']);
    expect(applicationDirs(process.env)).toEqual([join(userData, 'applications'), join(systemData, 'applications')]);
    expect(loadDesktopEntries(process.env).map(item => item.id)).toEqual(['ok']);
  });

  it('uses the standard data directories when the variables are not set', () => {
    expect(applicationDirs({ XDG_DATA_HOME: '', XDG_DATA_DIRS: '' }).slice(1)).toEqual([
      '/usr/local/share/applications',
      '/usr/share/applications',
    ]);
  });

  it('skips an entry file that is far too large', () => {
    useDesktop({ gio: 'fake' });
    writeFileSync(
      join(systemData, 'applications', 'huge.desktop'),
      `[Desktop Entry]\nType=Application\nName=Huge\nExec=/usr/bin/huge %f\n#${'x'.repeat(300 * 1024)}\n`,
    );
    expect(loadDesktopEntries(process.env)).toEqual([]);
  });
});

describe.skipIf(!LINUX)('Linux open_url', () => {
  it('launches the named app\'s own desktop entry with the address as the one argument, then brings the app forward', async () => {
    const logs = useDesktop({ gio: 'fake' });
    const file = entry('firefox', BROWSER);
    const executor = await linuxExecutor();
    expect(await executor.openUrl?.('firefox', 'https://example.com/docs')).toBe(true);
    expect(launches(logs.gio)).toEqual([['launch', file, 'https://example.com/docs']]);
    expect(lines(logs.xdo)).toContain('search --onlyvisible --class ^firefox$ windowactivate --sync');
  });

  it('is offered by the executor only when gio launch exists, so the runner can block it before anyone is asked', async () => {
    useDesktop({ gio: 'none' });
    const executor = await linuxExecutor();
    expect(executor.openUrl).toBeUndefined();
    expect(executor.openFile).toBeUndefined();
    const choice = await choosePlatform();
    expect(choice.detail).toContain('Install gio');
  });

  it('refuses a name that matches no installed app, and launches nothing', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('firefox', BROWSER);
    const executor = await linuxExecutor();
    const message = await refusal(executor.openUrl?.('netscape', 'https://example.com/'));
    expect(message).toContain('No installed application matches');
    expect(launches(logs.gio)).toEqual([]);
    expect(lines(logs.xdo).some(line => line.includes('windowactivate'))).toBe(false);
  });

  it('refuses an app that does not handle web addresses, even if it takes files', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('editor', EDITOR);
    const executor = await linuxExecutor();
    expect(await refusal(executor.openUrl?.('editor', 'https://example.com/'))).toBe('That application does not take a web address.');
    expect(launches(logs.gio)).toEqual([]);
  });

  it('refuses an app whose entry has no %u, since the launcher would start it and drop the address', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('firefox', ['Type=Application', 'Name=Firefox', 'Exec=/usr/bin/firefox --new-window', 'MimeType=x-scheme-handler/https;']);
    const executor = await linuxExecutor();
    expect(await refusal(executor.openUrl?.('firefox', 'https://example.com/'))).toBe('That application does not take a web address.');
    expect(launches(logs.gio)).toEqual([]);
  });

  it('refuses a name that two installed apps share, and launches nothing', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('firefox', BROWSER);
    entry('org.mozilla.firefox', BROWSER);
    const executor = await linuxExecutor();
    expect(await refusal(executor.openUrl?.('firefox', 'https://example.com/'))).toContain('More than one installed application');
    expect(launches(logs.gio)).toEqual([]);
  });

  it('does not use an entry that runs through a shell, a terminal or a hidden entry', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('wrapped', ['Type=Application', 'Name=Wrapped', 'Exec=sh -c "wrapped %u"', 'MimeType=x-scheme-handler/https;']);
    entry('terminal', ['Type=Application', 'Name=Term', 'Terminal=true', 'Exec=/usr/bin/term %u', 'MimeType=x-scheme-handler/https;']);
    entry('gone', ['Type=Application', 'Name=Gone', 'Hidden=true', 'Exec=/usr/bin/gone %u', 'MimeType=x-scheme-handler/https;']);
    const executor = await linuxExecutor();
    for (const app of ['wrapped', 'term', 'gone']) {
      expect(await refusal(executor.openUrl?.(app, 'https://example.com/'))).toContain('No installed application matches');
    }
    expect(launches(logs.gio)).toEqual([]);
  });

  it('returns false and launches nothing for an address the core refuses', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('firefox', BROWSER);
    const executor = await linuxExecutor();
    for (const url of [
      'https://example.com/?token=1',
      'https://user:pw@example.com/',
      'https://example.com/#frag',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'https://localhost/',
      'https://example.com:8443/',
      '--help',
    ]) {
      expect(await executor.openUrl?.('firefox', url)).toBe(false);
    }
    expect(launches(logs.gio)).toEqual([]);
  });

  it('returns false when the launcher fails, and does not try to bring the app forward', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('firefox', BROWSER);
    process.env.FAKE_GIO_EXIT = '1';
    const executor = await linuxExecutor();
    expect(await executor.openUrl?.('firefox', 'https://example.com/')).toBe(false);
    expect(launches(logs.gio)).toHaveLength(1);
    expect(lines(logs.xdo).some(line => line.includes('windowactivate'))).toBe(false);
  });

  it('still reports the launch when the window never comes forward, so the runner makes the check', async () => {
    const logs = useDesktop({ gio: 'fake', activate: 'fail' });
    entry('firefox', BROWSER);
    const executor = await linuxExecutor();
    expect(await executor.openUrl?.('firefox', 'https://example.com/')).toBe(true);
    expect(lines(logs.xdo).filter(line => line.includes('windowactivate')).length).toBeGreaterThan(1);
  });

  it('does not wait for the launched app to quit', async () => {
    useDesktop({ gio: 'fake' });
    entry('firefox', BROWSER);
    process.env.FAKE_GIO_BACKGROUND = '3';
    const executor = await linuxExecutor();
    const started = Date.now();
    expect(await executor.openUrl?.('firefox', 'https://example.com/')).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});

describe.skipIf(!LINUX)('Linux open_file', () => {
  function plainFile(name: string, text = 'data'): string {
    const path = join(files, name);
    writeFileSync(path, text);
    return path;
  }

  it('launches the named app\'s desktop entry with the real path of the file, following a link', async () => {
    const logs = useDesktop({ gio: 'fake' });
    const desktopFile = entry('editor', EDITOR);
    const real = plainFile('notes.txt');
    const link = join(files, 'notes-link.txt');
    symlinkSync(real, link);
    const executor = await linuxExecutor();
    expect(await executor.openFile?.('editor', link)).toBe(true);
    expect(launches(logs.gio)).toEqual([['launch', desktopFile, real]]);
    expect(lines(logs.xdo)).toContain('search --onlyvisible --class ^editor$ windowactivate --sync');
  });

  it('passes a path with shell characters as one literal argument', async () => {
    const logs = useDesktop({ gio: 'fake' });
    const desktopFile = entry('editor', EDITOR);
    const path = plainFile('a b $(touch pwned) & ; x.txt');
    const executor = await linuxExecutor();
    expect(await executor.openFile?.('editor', path)).toBe(true);
    expect(launches(logs.gio)).toEqual([['launch', desktopFile, path]]);
  });

  it('returns false and launches nothing for a path the core or the disk refuses', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('editor', EDITOR);
    const executor = await linuxExecutor();
    const script = plainFile('run.sh', '#!/bin/sh\n');
    const scriptLink = join(files, 'innocent.txt');
    symlinkSync(script, scriptLink);
    const folder = join(files, 'a-folder');
    mkdirSync(folder, { recursive: true });
    for (const path of [
      script,
      scriptLink,
      folder,
      join(files, 'missing.txt'),
      'relative/notes.txt',
      `${files}/../files/notes.txt`,
      join(files, '*.txt'),
    ]) {
      expect(await executor.openFile?.('editor', path)).toBe(false);
    }
    expect(launches(logs.gio)).toEqual([]);
  });

  it('refuses a shell as the app, even if an entry with that name existed', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('bash', ['Type=Application', 'Name=Bash', 'Exec=/usr/bin/bash %f']);
    const path = plainFile('notes.txt');
    const executor = await linuxExecutor();
    expect(await executor.openFile?.('bash', path)).toBe(false);
    expect(await executor.openFile?.('gnome-terminal', path)).toBe(false);
    expect(launches(logs.gio)).toEqual([]);
  });

  it('refuses an app with no file argument, and an app that is not installed', async () => {
    const logs = useDesktop({ gio: 'fake' });
    entry('viewer', ['Type=Application', 'Name=Viewer', 'Exec=/usr/bin/viewer --kiosk']);
    const path = plainFile('notes.txt');
    const executor = await linuxExecutor();
    expect(await refusal(executor.openFile?.('viewer', path))).toBe('That application does not take a file.');
    expect(await refusal(executor.openFile?.('nothing', path))).toContain('No installed application matches');
    expect(launches(logs.gio)).toEqual([]);
  });
});

describe.skipIf(!LINUX)('Linux open steps in the runner', () => {
  const ctx: PolicyContext = { level: 3, maxLevel: 4, unattended: false, excludedApps: [] };
  const run = (step: Step, executor: Executor) =>
    runAutomation(
      AutomationSchema.parse({ id: 'auto_linux', name: 'Linux', version: 1, routineId: 'r1', params: [], steps: [step] }),
      { mode: 'supervised', policy: ctx, approve: async () => true, settleMs: 0 },
      executor,
    );

  it('completes when the launch works and the named app is in front', async () => {
    useDesktop({ gio: 'fake', active: '100' });
    entry('firefox', BROWSER);
    const result = await run({ op: 'open_url', app: 'firefox', url: 'https://example.com/docs' }, await linuxExecutor());
    expect(result.status).toBe('completed');
    expect(result.postconditionsPassed).toBe(1);
  });

  it('fails the check when another app is in front after the launch', async () => {
    useDesktop({ gio: 'fake', active: '100', wmClass: 'WM_CLASS(STRING) = "xterm", "XTerm"' });
    entry('firefox', BROWSER);
    const result = await run({ op: 'open_url', app: 'firefox', url: 'https://example.com/docs' }, await linuxExecutor());
    expect(result.status).toBe('failed');
    expect(result.steps[0]?.outcome).toBe('check_failed');
  });

  it('blocks the run, with the reason, when the app cannot be resolved, and launches nothing', async () => {
    const logs = useDesktop({ gio: 'fake' });
    const result = await run({ op: 'open_url', app: 'firefox', url: 'https://example.com/docs' }, await linuxExecutor());
    expect(result.status).toBe('blocked');
    expect(result.steps[0]?.outcome).toBe('blocked');
    expect(result.steps[0]?.failureReason).toContain('No installed application matches');
    expect(launches(logs.gio)).toEqual([]);
  });

  it('blocks an open step before anyone is asked when gio is not installed', async () => {
    useDesktop({ gio: 'none' });
    let asked = false;
    const result = await runAutomation(
      AutomationSchema.parse({
        id: 'auto_linux',
        name: 'Linux',
        version: 1,
        routineId: 'r1',
        params: [],
        steps: [{ op: 'open_file', app: 'editor', path: join(files, 'notes.txt') }],
      }),
      { mode: 'supervised', policy: ctx, approve: async () => ((asked = true), true), settleMs: 0 },
      await linuxExecutor(),
    );
    expect(result.status).toBe('blocked');
    expect(result.steps[0]?.reason).toBe('This system cannot open files yet.');
    expect(asked).toBe(false);
  });
});

describe.skipIf(!LINUX)('launchDetached', () => {
  it('reports the exit status of the launcher', async () => {
    expect(await launchDetached('bash', ['-c', 'exit 0'])).toBe(true);
    expect(await launchDetached('bash', ['-c', 'exit 3'])).toBe(false);
  });

  it('reports false for a program that does not exist', async () => {
    expect(await launchDetached('/nonexistent/program', [])).toBe(false);
  });

  it('returns when the launcher exits even if a child it started keeps running', async () => {
    const started = Date.now();
    expect(await launchDetached('bash', ['-c', '(sleep 3 &); exit 0'])).toBe(true);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it('stops a launcher that is still running at the time limit, by its process ID', async () => {
    const pidFile = join(root, `pid-${Math.random().toString(36).slice(2)}`);
    const started = Date.now();
    expect(await launchDetached('bash', ['-c', `echo $$ > "${pidFile}"; exec sleep 30`], 300)).toBe(false);
    expect(Date.now() - started).toBeLessThan(3000);
    const pid = Number(readFileSync(pidFile, 'utf8').trim());
    expect(pid).toBeGreaterThan(1);
    let alive = true;
    for (let attempt = 0; attempt < 20 && alive; attempt++) {
      try {
        process.kill(pid, 0);
        await new Promise(resolve => setTimeout(resolve, 50));
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  it('passes each argument as it is, with no shell to read it', async () => {
    const out = join(root, `args-${Math.random().toString(36).slice(2)}`);
    const tricky = '$(touch pwned); `id` & > x';
    expect(await launchDetached('bash', ['-c', 'printf "%s\\n" "$@" > "$0"', out, tricky, 'a b'])).toBe(true);
    expect(readFileSync(out, 'utf8').split('\n').slice(0, 2)).toEqual([tricky, 'a b']);
  });
});

/** The same contract with the real gio, so the fake is not the only evidence that the target arrives as one argument. */
const REAL_GIO = LINUX && spawnSync('gio', ['help', 'launch'], { stdio: 'ignore' }).status === 0;

describe.skipIf(!REAL_GIO)('Linux open steps with the real gio launch', () => {
  async function waitForArgs(log: string): Promise<string[] | undefined> {
    for (let attempt = 0; attempt < 60; attempt++) {
      if (existsSync(log)) return readFileSync(log, 'utf8').split('\0').slice(0, -1);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    return undefined;
  }

  /** An app that records each argument it is started with, NUL-separated, in APP_LOG. */
  function recordingApp(): string {
    return script(tools, 'recorder', '#!/bin/bash\nprintf \'%s\\0\' "$@" > "$APP_LOG"\n');
  }

  it('starts the entry\'s program with the address as its one argument', async () => {
    const logs = useDesktop({ gio: 'real' });
    entry('firefox', [...BROWSER.filter(line => !line.startsWith('Exec=')), `Exec=${recordingApp()} --fixed %u`]);
    const executor = await linuxExecutor();
    expect(await executor.openUrl?.('firefox', 'https://example.com/docs')).toBe(true);
    expect(await waitForArgs(logs.app)).toEqual(['--fixed', 'https://example.com/docs']);
  });

  it('starts the entry\'s program with a hostile file name as one literal argument and runs nothing else', async () => {
    const logs = useDesktop({ gio: 'real' });
    entry('editor', ['Type=Application', 'Name=Text Editor', `Exec=${recordingApp()} %f`]);
    // A shell that read this name would create the file MARKER names. No file name can hold a slash, so it goes through the environment.
    const marker = join(files, 'pwned');
    process.env.MARKER = marker;
    const path = join(files, 'x $(touch $MARKER) ; touch $MARKER & ${MARKER} y.txt');
    writeFileSync(path, 'data');
    const executor = await linuxExecutor();
    expect(await executor.openFile?.('editor', path)).toBe(true);
    expect(await waitForArgs(logs.app)).toEqual([path]);
    expect(existsSync(marker)).toBe(false);
  });

  it('passes the file as one argument to an entry that takes %u, as a path or as a file URI depending on the GLib version', async () => {
    const logs = useDesktop({ gio: 'real' });
    entry('editor', ['Type=Application', 'Name=Text Editor', `Exec=${recordingApp()} %u`]);
    const path = join(files, 'uri-notes.txt');
    writeFileSync(path, 'data');
    const executor = await linuxExecutor();
    expect(await executor.openFile?.('editor', path)).toBe(true);
    const args = await waitForArgs(logs.app);
    expect(args).toHaveLength(1);
    expect([path, `file://${path}`]).toContain(args?.[0]);
  });
});
