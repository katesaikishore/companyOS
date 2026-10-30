import { describe, expect, it } from 'vitest';
import { FLOOR_EFFECTS, evaluateStep, type PolicyContext, type Step } from '../src';

const ctx = (overrides: Partial<PolicyContext> = {}): PolicyContext => ({
  level: 3,
  maxLevel: 4,
  unattended: false,
  excludedApps: ['1password'],
  ...overrides,
});

const link: Step = { op: 'open_url', app: 'google chrome', url: 'https://docs.example.com/doc' };
const file: Step = { op: 'open_file', app: 'microsoft excel', path: '/Users/me/Documents/budget.xlsx' };
const chord: Step = { op: 'press_shortcut', app: 'microsoft excel', shortcut: 'cmd+shift+k' };

describe('policy floor', () => {
  it('is unchanged by the new steps', () => {
    expect([...FLOOR_EFFECTS]).toEqual(['external_effect', 'money', 'deletion', 'permission', 'install']);
  });
});

describe('open_url', () => {
  it('asks a person when supervised, and never runs unattended', () => {
    expect(evaluateStep(link, ctx())).toMatchObject({ decision: 'ask', effect: 'external_effect' });
    expect(evaluateStep(link, ctx({ level: 4, unattended: true }))).toMatchObject({ decision: 'deny', effect: 'external_effect' });
  });

  it('opens only in a known browser', () => {
    expect(evaluateStep({ ...link, app: 'slack' }, ctx())).toMatchObject({
      decision: 'deny',
      reason: 'Links open only in a web browser.',
    });
  });

  it('refuses an address the schema would refuse', () => {
    expect(evaluateStep({ ...link, url: 'javascript:alert(1)' }, ctx()).decision).toBe('deny');
    expect(evaluateStep({ ...link, url: 'https://example.com/?q=1' }, ctx()).decision).toBe('deny');
  });
});

describe('open_file', () => {
  it('asks for this exact file on every supervised run, as an external effect', () => {
    expect(evaluateStep(file, ctx())).toMatchObject({ decision: 'ask', effect: 'external_effect' });
    expect(evaluateStep(file, ctx({ level: 4 })).decision).toBe('ask');
  });

  it('never runs unattended, even at level 4', () => {
    expect(evaluateStep(file, ctx({ level: 4, unattended: true })).decision).toBe('deny');
  });

  it('refuses a path that is not exact', () => {
    expect(evaluateStep({ ...file, path: '/Users/me/*.xlsx' }, ctx()).decision).toBe('deny');
    expect(evaluateStep({ ...file, path: '/Users/me/Documents/' }, ctx()).decision).toBe('deny');
  });
});

describe('press_shortcut', () => {
  it('always asks, and never runs unattended', () => {
    expect(evaluateStep(chord, ctx())).toMatchObject({ decision: 'ask', effect: 'external_effect' });
    expect(evaluateStep(chord, ctx({ level: 4, unattended: true })).decision).toBe('deny');
  });

  it('refuses a chord that is not in canonical form', () => {
    expect(evaluateStep({ ...chord, shortcut: 'shift+cmd+k' }, ctx()).decision).toBe('deny');
  });
});

describe('shell targets', () => {
  // A file or a key press sent to one of these can run commands, so it is refused even when a person would approve it.
  it.each(['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh', 'terminal', 'osascript', 'python', 'node', 'Windows Terminal'])(
    'refuses %s as the app for a file',
    app => {
      expect(evaluateStep({ ...file, app }, ctx())).toMatchObject({ decision: 'deny' });
    },
  );

  it.each(['powershell', 'pwsh', 'cmd', 'bash', 'zsh', 'sh', 'terminal', 'osascript', 'python', 'node', 'Windows Terminal'])(
    'refuses %s as the app for a key press',
    app => {
      expect(evaluateStep({ ...chord, app }, ctx())).toMatchObject({ decision: 'deny' });
    },
  );

  it('still allows focusing a shell, which sends no keys', () => {
    expect(evaluateStep({ op: 'focus_app', app: 'terminal' }, ctx()).decision).toBe('allow');
    expect(evaluateStep({ op: 'check_focus', app: 'terminal' }, ctx()).decision).toBe('allow');
  });
});

describe('the older rules still apply to the new steps', () => {
  it('denies excluded apps before anything else', () => {
    expect(evaluateStep({ op: 'open_file', app: '1password', path: '/Users/me/vault.txt' }, ctx())).toMatchObject({
      decision: 'deny',
    });
  });

  it('draft level never executes a new step', () => {
    expect(evaluateStep(file, ctx({ level: 2 })).decision).toBe('deny');
    expect(evaluateStep(link, ctx({ level: 2 })).decision).toBe('deny');
  });

  it('unattended level 4 still allows focus and check on a local app', () => {
    expect(evaluateStep({ op: 'focus_app', app: 'microsoft excel' }, ctx({ level: 4, unattended: true })).decision).toBe('allow');
    expect(evaluateStep({ op: 'check_focus', app: 'microsoft excel' }, ctx({ level: 4, unattended: true })).decision).toBe('allow');
    expect(evaluateStep({ op: 'focus_app', app: 'slack' }, ctx({ level: 4, unattended: true })).decision).toBe('deny');
  });
});

describe('file names that hide a program', () => {
  // Windows drops a trailing dot or space, and a colon after the drive letter starts an alternate data stream.
  it.each([
    ['a trailing dot', 'C:\\Users\\me\\Downloads\\setup.exe.'],
    ['a trailing space', 'C:\\Users\\me\\Downloads\\setup.exe '],
    ['an alternate data stream', 'C:\\Users\\me\\Downloads\\setup.exe:stream'],
  ])('refuses a file with %s, even when a person would approve it', (_label, path) => {
    expect(evaluateStep({ ...file, path }, ctx())).toMatchObject({ decision: 'deny' });
  });
});

describe('Windows script hosts and launchers as targets', () => {
  const HOSTS = ['wscript', 'cscript', 'mshta', 'rundll32', 'regsvr32', 'msiexec', 'Windows PowerShell', 'pythonw', 'py'];

  it.each(HOSTS)('refuses %s as the app for a file', app => {
    expect(evaluateStep({ ...file, app }, ctx())).toMatchObject({ decision: 'deny' });
  });

  it.each(HOSTS)('refuses %s as the app for a key press', app => {
    expect(evaluateStep({ ...chord, app }, ctx())).toMatchObject({ decision: 'deny' });
  });

  it('still allows focusing a script host, which sends no keys', () => {
    expect(evaluateStep({ op: 'focus_app', app: 'wscript' }, ctx()).decision).toBe('allow');
  });
});
