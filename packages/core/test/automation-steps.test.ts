import { mkdirSync, mkdtempSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AutomationSchema,
  DAY_MS,
  EncryptedStore,
  StepSchema,
  TwinAgent,
  describeStep,
  effectOfOp,
  effectsOf,
  evaluateStep,
  initialState,
  isSafeFilePath,
  isShellApp,
  openableFilePath,
  parseKeyChord,
  parseWebAddress,
  promotionCheck,
  resolveStep,
  type Automation,
  type AutonomyState,
  type FileStat,
  type PolicyContext,
  type RunRecord,
  type Step,
} from '../src';

describe('parseWebAddress', () => {
  it('accepts http and https addresses and returns the canonical form', () => {
    expect(parseWebAddress('https://Docs.Example.com/doc')?.href).toBe('https://docs.example.com/doc');
    expect(parseWebAddress('http://intranet.example.org/')?.protocol).toBe('http:');
    // A colon after the host is part of the path, not a port, so it is still allowed.
    expect(parseWebAddress('https://docs.example.com/doc/a:b')?.href).toBe('https://docs.example.com/doc/a:b');
  });

  it.each([
    ['another scheme', 'javascript:alert(1)'],
    ['a file', 'file:///Users/me/secret.txt'],
    ['ftp', 'ftp://files.example.com/a'],
    ['a login', 'https://me:pw@example.com/'],
    ['a query', 'https://example.com/doc?token=abc'],
    ['a fragment', 'https://example.com/doc#top'],
    ['an explicit port', 'https://example.com:8443/doc'],
    ['the default https port, written out', 'https://example.com:443/doc'],
    ['the default http port, written out', 'http://intranet.example.org:80/'],
    ['a bare host', 'https://localhost/doc'],
    ['whitespace', 'https://example.com/a b'],
    ['a relative path', '/doc/1'],
  ])('refuses %s', (_label, value) => {
    expect(parseWebAddress(value)).toBeUndefined();
  });
});

describe('isSafeFilePath', () => {
  it('accepts one exact absolute file path', () => {
    expect(isSafeFilePath('/Users/me/Documents/Budget 2026.xlsx')).toBe(true);
    expect(isSafeFilePath('C:\\Users\\me\\Documents\\budget.xlsx')).toBe(true);
    expect(isSafeFilePath('D:/work/notes.txt')).toBe(true);
  });

  it.each([
    ['a relative path', 'Documents/budget.xlsx'],
    ['a folder', '/Users/me/Documents/'],
    ['a folder on Windows', 'C:\\Users\\me\\'],
    ['a wildcard', '/Users/me/Documents/*.xlsx'],
    ['a question mark', '/Users/me/Documents/budget?.xlsx'],
    ['a parent segment', '/Users/me/../other/budget.xlsx'],
    ['a network share', '\\\\server\\share\\budget.xlsx'],
    ['a program bundle', '/Applications/Calculator.app'],
    ['a script', '/Users/me/bin/run.sh'],
    ['an installer', 'C:\\Downloads\\setup.exe'],
    ['a shortcut file', 'C:\\Users\\me\\Desktop\\report.lnk'],
    ['a quote', '/Users/me/"x".xlsx'],
    ['a single quote', "/Users/me/Bob's budget.xlsx"],
    ['a backtick', '/Users/me/`budget`.xlsx'],
    ['an empty path', ''],
    ['a drive-relative path', 'C:budget.xlsx'],
  ])('refuses %s', (_label, value) => {
    expect(isSafeFilePath(value)).toBe(false);
  });

  it.each([
    'webloc',
    'mpkg',
    'pkg',
    'scpt',
    'scptd',
    'applescript',
    'msc',
    'cpl',
    'ocx',
    'scf',
    'application',
    'command',
    'workflow',
    'url',
    'reg',
    'hta',
    'wsf',
    'vbs',
    'js',
    'jar',
    'msi',
    'bat',
    'cmd',
    'com',
    'scr',
    'ps1',
    'dll',
  ])('refuses a program or script ending in .%s, in either case', extension => {
    expect(isSafeFilePath(`/Users/me/Downloads/setup.${extension}`)).toBe(false);
    expect(isSafeFilePath(`C:\\Users\\me\\Downloads\\setup.${extension.toUpperCase()}`)).toBe(false);
  });

  // Windows drops a trailing dot or space from a name, so "setup.exe." runs as "setup.exe". A colon after the drive
  // letter starts an alternate data stream, so "setup.exe:stream" keeps the program's name out of the extension check.
  it.each([
    ['a trailing dot after a program', 'C:\\Users\\me\\Downloads\\setup.exe.'],
    ['a trailing space after a program', 'C:\\Users\\me\\Downloads\\setup.exe '],
    ['a trailing dot and space after a program', 'C:\\Users\\me\\Downloads\\setup.exe. '],
    ['a trailing dot after a document', '/Users/me/Documents/budget.xlsx.'],
    ['a trailing space after a document', '/Users/me/Documents/budget.xlsx '],
    ['an alternate data stream on a program', 'C:\\Users\\me\\Downloads\\setup.exe:stream'],
    ['a zone marker alternate data stream on a program', 'C:\\Users\\me\\Downloads\\setup.exe:Zone.Identifier'],
    ['a trailing colon after a program', 'C:\\Users\\me\\Downloads\\setup.exe:'],
    ['an alternate data stream on a document', 'C:\\Users\\me\\Documents\\budget.xlsx:setup.exe'],
    ['a colon in a Unix-style path', '/Users/me/Downloads/setup.exe:stream'],
    ['a colon in a folder name after the drive', 'C:\\Users\\me:old\\Documents\\budget.xlsx'],
  ])('refuses %s', (_label, value) => {
    expect(isSafeFilePath(value)).toBe(false);
  });
});

describe('openableFilePath', () => {
  /** The same check the desktop adapter makes: follow any link, then ask the disk whether the target is a file. */
  const statOnDisk = (path: string): FileStat | undefined => {
    try {
      const realPath = realpathSync(path);
      return { realPath, isFile: statSync(realPath).isFile() };
    } catch {
      return undefined;
    }
  };

  it('refuses a folder with no extension and accepts a regular file, on the real disk', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-open-'));
    try {
      const folder = join(dir, 'Budget');
      const file = join(dir, 'budget.xlsx');
      mkdirSync(folder);
      writeFileSync(file, 'x');
      // The name rules alone accept a folder, so the disk check is what refuses it.
      expect(isSafeFilePath(folder)).toBe(true);
      expect(openableFilePath(folder, statOnDisk)).toBeUndefined();
      expect(openableFilePath(file, statOnDisk)).toBe(realpathSync(file));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a link to a program, as it would refuse the program', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-open-'));
    try {
      const program = join(dir, 'tool.sh');
      const link = join(dir, 'budget.xlsx');
      writeFileSync(program, '#!/bin/sh\n');
      symlinkSync(program, link);
      expect(openableFilePath(link, statOnDisk)).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path the disk cannot read, and a name the rules refuse before the disk is asked', () => {
    expect(openableFilePath('/Users/me/missing.xlsx', () => undefined)).toBeUndefined();
    expect(openableFilePath('/Users/me/*.xlsx', () => ({ realPath: '/Users/me/a.xlsx', isFile: true }))).toBeUndefined();
  });
});

describe('parseKeyChord', () => {
  it('returns the canonical order of modifiers', () => {
    expect(parseKeyChord('cmd+shift+k')).toBe('cmd+shift+k');
    expect(parseKeyChord('shift+cmd+k')).toBe('cmd+shift+k');
    expect(parseKeyChord('alt+f4')).toBe('alt+f4');
    expect(parseKeyChord('ctrl+pagedown')).toBe('ctrl+pagedown');
  });

  it.each([
    ['no modifier', 'k'],
    ['an unknown modifier', 'win+k'],
    ['a repeated modifier', 'cmd+cmd+k'],
    ['an unknown key', 'cmd+printscreen'],
    ['an empty key', 'cmd+'],
    ['a key with no modifier', 'return'],
  ])('refuses %s', (_label, value) => {
    expect(parseKeyChord(value)).toBeUndefined();
  });
});

describe('StepSchema', () => {
  it('accepts each new step in its checked form', () => {
    expect(StepSchema.parse({ op: 'open_url', app: 'Google Chrome', url: 'https://docs.example.com/doc' })).toMatchObject({ op: 'open_url' });
    expect(StepSchema.parse({ op: 'open_url', app: 'Google Chrome', url: '$p1' })).toMatchObject({ url: '$p1' });
    expect(StepSchema.parse({ op: 'open_file', app: 'Microsoft Excel', path: '/Users/me/Documents/budget.xlsx' })).toMatchObject({
      op: 'open_file',
    });
    expect(StepSchema.parse({ op: 'press_shortcut', app: 'Microsoft Excel', shortcut: 'cmd+shift+k' })).toMatchObject({
      op: 'press_shortcut',
    });
  });

  it('refuses unsafe values when the step loads', () => {
    expect(() => StepSchema.parse({ op: 'open_url', app: 'Google Chrome', url: 'https://example.com/doc?token=abc' })).toThrow();
    expect(() => StepSchema.parse({ op: 'open_url', app: 'Google Chrome', url: 'javascript:alert(1)' })).toThrow();
    expect(() => StepSchema.parse({ op: 'open_url', app: '/Applications/Chrome.app', url: 'https://example.com/doc' })).toThrow();
    expect(() => StepSchema.parse({ op: 'open_file', app: 'Microsoft Excel', path: '/Users/me/*.xlsx' })).toThrow();
    expect(() => StepSchema.parse({ op: 'open_file', app: 'Microsoft Excel', path: '/Users/me/' })).toThrow();
    expect(() => StepSchema.parse({ op: 'press_shortcut', app: 'Microsoft Excel', shortcut: 'shift+cmd+k' })).toThrow();
  });

  it('refuses unknown operations and unknown fields', () => {
    expect(() => StepSchema.parse({ op: 'type_text', app: 'Slack', text: 'hi' })).toThrow();
    expect(() => StepSchema.parse({ op: 'open_url', app: 'Google Chrome', url: 'https://example.com/doc', query: 'x' })).toThrow();
  });
});

describe('version 1 automations', () => {
  // The shape compileRoutine wrote before the new steps existed. It must keep loading unchanged.
  const legacy = {
    id: 'auto_ab12cd34ef56',
    name: 'Routine: spreadsheet → mail',
    version: 1,
    routineId: 'ab12cd34ef56',
    params: [{ name: 'p0', options: ['microsoft excel', 'libreoffice calc'], default: 'microsoft excel' }],
    steps: [
      { op: 'focus_app', app: '$p0' },
      { op: 'check_focus', app: '$p0' },
      { op: 'focus_app', app: 'microsoft outlook' },
      { op: 'check_focus', app: 'microsoft outlook' },
    ],
    estimate: { minutesPerWeek: 12.5, occurrencesPerWeek: 5 },
  };

  it('still parses unchanged', () => {
    expect(AutomationSchema.parse(legacy)).toEqual(legacy);
  });

  it('is read back from the store by the agent with its state intact', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-steps-'));
    const key = randomBytes(32);
    const store = new EncryptedStore(dir, key);
    store.replaceAll('automations', [legacy]);
    store.replaceAll('autonomy', [{ automationId: legacy.id, level: 3, effects: ['read_only'], runs: [] }]);

    const views = new TwinAgent({ dataDir: dir, dataKey: key }).automations();
    expect(views).toHaveLength(1);
    expect(views[0].automation).toEqual(legacy);
    expect(views[0].state.level).toBe(3);
  });
});

describe('effects of the steps', () => {
  it('classifies the new steps as external, since the twin cannot see what the app does next', () => {
    expect(effectOfOp('open_url', 'Google Chrome')).toBe('external_effect');
    expect(effectOfOp('press_shortcut', 'Microsoft Excel')).toBe('external_effect');
    expect(effectOfOp('open_file', 'Microsoft Excel')).toBe('external_effect');
  });

  it('leaves focus and check as they were', () => {
    expect(effectOfOp('focus_app', 'Microsoft Excel')).toBe('read_only');
    expect(effectOfOp('focus_app', 'Slack')).toBe('external_effect');
    expect(effectOfOp('check_focus', 'Slack')).toBe('read_only');
  });

  it('lists the effect of a new step in an automation', () => {
    const automation = AutomationSchema.parse({
      id: 'auto_mixed',
      name: 'Mixed',
      version: 2,
      routineId: 'mixed',
      params: [],
      steps: [
        { op: 'focus_app', app: 'microsoft excel' },
        { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' },
      ],
    });
    expect(effectsOf(automation).sort()).toEqual(['external_effect', 'read_only']);
  });
});

describe('resolveStep', () => {
  const params = [
    {
      name: 'p1',
      options: ['https://docs.example.com/doc/a1', 'https://docs.example.com/doc/b2'],
      default: 'https://docs.example.com/doc/a1',
    },
  ];

  it('binds an approved URL option', () => {
    const step: Step = { op: 'open_url', app: 'google chrome', url: '$p1' };
    expect(resolveStep(step, params, { p1: 'https://docs.example.com/doc/b2' })).toEqual({
      op: 'open_url',
      app: 'google chrome',
      url: 'https://docs.example.com/doc/b2',
    });
  });

  it('refuses a URL value that was not approved', () => {
    const step: Step = { op: 'open_url', app: 'google chrome', url: '$p1' };
    expect(() => resolveStep(step, params, { p1: 'https://evil.example.net/' })).toThrow(/not an observed option/);
  });

  it('refuses an approved option that is not an allowed address', () => {
    const unsafe = [{ name: 'p1', options: ['javascript:alert(1)', 'https://docs.example.com/doc'], default: 'https://docs.example.com/doc' }];
    const step: Step = { op: 'open_url', app: 'google chrome', url: '$p1' };
    expect(() => resolveStep(step, unsafe, { p1: 'javascript:alert(1)' })).toThrow(/not an allowed/);
  });

  it('refuses a bound application name that is not plain', () => {
    const apps = [{ name: 'p0', options: ['/Applications/Calc.app', 'microsoft excel'], default: 'microsoft excel' }];
    const step: Step = { op: 'open_file', app: '$p0', path: '/Users/me/a.xlsx' };
    expect(() => resolveStep(step, apps, { p0: '/Applications/Calc.app' })).toThrow(/application name/);
  });

  it('keeps focus steps exactly as before', () => {
    const apps = [{ name: 'p0', options: ['microsoft excel', 'libreoffice calc'], default: 'microsoft excel' }];
    expect(resolveStep({ op: 'focus_app', app: '$p0' }, apps, { p0: 'libreoffice calc' })).toEqual({
      op: 'focus_app',
      app: 'libreoffice calc',
    });
  });
});

describe('describeStep', () => {
  it('names the exact address, file and chord that will be used', () => {
    expect(describeStep({ op: 'open_url', app: 'Google Chrome', url: 'https://docs.example.com/doc' })).toBe(
      'Open https://docs.example.com/doc in "Google Chrome"?',
    );
    expect(describeStep({ op: 'open_file', app: 'Microsoft Excel', path: '/Users/me/Documents/budget.xlsx' })).toBe(
      'Open /Users/me/Documents/budget.xlsx in "Microsoft Excel"?',
    );
    expect(describeStep({ op: 'press_shortcut', app: 'Microsoft Excel', shortcut: 'cmd+shift+k' })).toBe(
      'Press cmd+shift+k in "Microsoft Excel"?',
    );
  });

  it('keeps the wording of the focus steps', () => {
    expect(describeStep({ op: 'focus_app', app: 'slack' })).toBe('Bring "slack" to the front?');
    expect(describeStep({ op: 'check_focus', app: 'slack' })).toBe('Check that "slack" is in front?');
  });
});

describe('shell targets', () => {
  const SHELLS = ['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh', 'terminal', 'osascript', 'python', 'node'];

  it.each(SHELLS)('refuses %s as the app for an open file step when the step loads', app => {
    expect(StepSchema.safeParse({ op: 'open_file', app, path: '/Users/me/Documents/budget.xlsx' }).success).toBe(false);
  });

  it.each(SHELLS)('refuses %s as the app for a press shortcut step when the step loads', app => {
    expect(StepSchema.safeParse({ op: 'press_shortcut', app, shortcut: 'cmd+shift+k' }).success).toBe(false);
  });

  it.each(['cmd.exe', 'Terminal.app', 'Windows Terminal', 'Command Prompt', 'python3.12', 'iTerm2'])('refuses %s too', app => {
    expect(StepSchema.safeParse({ op: 'press_shortcut', app, shortcut: 'cmd+k' }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'open_file', app, path: '/Users/me/a.xlsx' }).success).toBe(false);
  });

  it('still lets a shell be focused, since focus sends no keys', () => {
    expect(StepSchema.safeParse({ op: 'focus_app', app: 'terminal' }).success).toBe(true);
  });

  it('refuses a shell that an approved parameter option names, before anything runs', () => {
    const params = [{ name: 'p0', options: ['terminal', 'microsoft excel'], default: 'microsoft excel' }];
    expect(() => resolveStep({ op: 'press_shortcut', app: '$p0', shortcut: 'cmd+k' }, params, { p0: 'terminal' })).toThrow(/cannot be the target/);
    expect(() => resolveStep({ op: 'open_file', app: '$p0', path: '/Users/me/a.xlsx' }, params, { p0: 'terminal' })).toThrow(/cannot be the target/);
  });
});

describe('Windows script hosts and launchers as targets', () => {
  const HOSTS = ['wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'Windows PowerShell', 'pythonw', 'py'];

  it.each(HOSTS)('counts %s as a shell', app => {
    expect(isShellApp(app)).toBe(true);
  });

  it.each(HOSTS)('refuses %s as the app for an open file step when the step loads', app => {
    expect(StepSchema.safeParse({ op: 'open_file', app, path: '/Users/me/Documents/budget.xlsx' }).success).toBe(false);
  });

  it.each(HOSTS)('refuses %s as the app for a press shortcut step when the step loads', app => {
    expect(StepSchema.safeParse({ op: 'press_shortcut', app, shortcut: 'cmd+shift+k' }).success).toBe(false);
  });

  it.each(['WScript.exe', 'rundll32.exe', 'MSIEXEC.EXE', 'Windows PowerShell.exe', 'py.exe'])('refuses %s, with its program extension, too', app => {
    expect(StepSchema.safeParse({ op: 'press_shortcut', app, shortcut: 'cmd+k' }).success).toBe(false);
    expect(StepSchema.safeParse({ op: 'open_file', app, path: '/Users/me/a.xlsx' }).success).toBe(false);
  });

  it('refuses an approved script host that a parameter option names, before anything runs', () => {
    const params = [{ name: 'p0', options: ['rundll32', 'microsoft excel'], default: 'microsoft excel' }];
    expect(() => resolveStep({ op: 'press_shortcut', app: '$p0', shortcut: 'cmd+k' }, params, { p0: 'rundll32' })).toThrow(/cannot be the target/);
  });
});

describe('trailing dots and spaces on shell names', () => {
  // Windows drops a trailing dot or space from a name, so "wscript.exe." starts the same program as "wscript.exe".
  it.each(['wscript.exe.', 'py.exe.', 'cmd .', 'powershell.exe', 'POWERSHELL.EXE', 'powershell.exe ', 'wscript .exe.', 'Terminal.'])(
    'counts %s as a shell',
    app => {
      expect(isShellApp(app)).toBe(true);
    },
  );

  it.each(['wscript.exe.', 'py.exe.', 'cmd .', 'powershell.exe', 'POWERSHELL.EXE'])(
    'refuses %s as the app for an open file or a press shortcut step',
    app => {
      expect(StepSchema.safeParse({ op: 'open_file', app, path: '/Users/me/Documents/budget.xlsx' }).success).toBe(false);
      expect(StepSchema.safeParse({ op: 'press_shortcut', app, shortcut: 'cmd+k' }).success).toBe(false);
    },
  );

  it('still accepts a normal app such as Slack as the app for an open file or a press shortcut step', () => {
    expect(isShellApp('Slack')).toBe(false);
    expect(StepSchema.safeParse({ op: 'open_file', app: 'Slack', path: '/Users/me/Documents/budget.xlsx' }).success).toBe(true);
    expect(StepSchema.safeParse({ op: 'press_shortcut', app: 'Slack', shortcut: 'cmd+k' }).success).toBe(true);
  });

  // The path rules already refuse a name that ends in a dot or a space. These cases keep it that way.
  it.each(['/Users/me/Documents/budget.', '/Users/me/Documents/notes.txt.', '/Users/me/Documents/notes.txt ', '/Users/me/Documents/budget.xlsx .'])(
    'refuses the file name in %s for an open file step',
    path => {
      expect(StepSchema.safeParse({ op: 'open_file', app: 'Slack', path }).success).toBe(false);
    },
  );
});

describe('promotion gate for the new steps', () => {
  const NOW = Date.UTC(2026, 9, 30);
  const config = { maxLevel: 4 as const, allowUnattended: true };
  const unattended: PolicyContext = { level: 4, maxLevel: 4, unattended: true, excludedApps: [] };

  /** Every condition except the effects is met, so only the effects can hold the automation back. */
  function earned(automation: Automation): AutonomyState {
    const runs: RunRecord[] = Array.from({ length: 30 }, () => ({
      ts: NOW - DAY_MS,
      mode: 'supervised',
      level: 3,
      status: 'completed',
      postconditionsPassed: 4,
      postconditionsFailed: 0,
      reverted: false,
    }));
    return { ...initialState(automation.id, effectsOf(automation)), level: 3, runs };
  }

  const focus: Step = { op: 'focus_app', app: 'microsoft excel' };
  const opens: [string, Step][] = [
    ['a link', { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' }],
    ['a file', { op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' }],
    ['a key press', { op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' }],
  ];

  it('offers level 4 for a focus-only automation that meets the same record', () => {
    const automation = AutomationSchema.parse({ id: 'auto_focus', name: 'Focus', version: 2, routineId: 'focus', params: [], steps: [focus] });
    expect(promotionCheck(earned(automation), NOW, config).eligible).toBe(true);
  });

  it.each(opens)('never offers level 4 for an automation with %s, and policy denies it unattended', (_label, step) => {
    const automation = AutomationSchema.parse({
      id: 'auto_opens',
      name: 'Opens',
      version: 2,
      routineId: 'opens',
      params: [],
      steps: [focus, step],
    });
    const check = promotionCheck(earned(automation), NOW, config);
    expect(check.eligible).toBe(false);
    expect(check.reasons).toContain('Some of its effects can never run unattended.');
    expect(evaluateStep(step, unattended).decision).toBe('deny');
  });

  it('treats a stored list that says read_only for open_file as external, and never offers it level 4', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-stale-effects-'));
    try {
      const key = randomBytes(32);
      const automation = AutomationSchema.parse({
        id: 'auto_stale',
        name: 'Stale effects',
        version: 2,
        routineId: 'stale',
        params: [],
        steps: [{ op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' }],
      });
      // Saved before open_file was classified as an external effect, so the stored list still says read_only.
      const stored: AutonomyState = { ...earned(automation), effects: ['read_only'] };
      const store = new EncryptedStore(dir, key);
      store.replaceAll('automations', [automation]);
      store.replaceAll('autonomy', [stored]);

      const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => NOW });
      agent.updateConfig({ maxAutonomyLevel: 4, allowUnattended: true });
      const [view] = agent.automations();
      expect(view.state.effects).toEqual(['external_effect']);
      expect(view.promotion.eligible).toBe(false);
      expect(view.promotion.reasons).toContain('Some of its effects can never run unattended.');
      expect(() => agent.promote(automation.id)).toThrow(/Not eligible for level 4/);
      expect(agent.automations()[0].state.level).toBe(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
