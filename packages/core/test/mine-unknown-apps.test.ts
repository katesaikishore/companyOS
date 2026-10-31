import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TwinAgent,
  compileRoutine,
  computeReadiness,
  mineRoutines,
  normalizeSignal,
  segment,
  type RawSignal,
  type Routine,
  type TwinEvent,
} from '../src';
import { at } from './fixtures';

const GAP = 60 * 60_000;
/** The planted routine as the steps it should mine to. Nothing else may appear in it. */
const PLANTED = ['microsoft excel', 'microsoft outlook', 'slack', 'google chrome'];

/** One stretch of work on a day: each app a few minutes after the one before, then an idle break. */
function stretchOn(day: number, apps: readonly string[], hour = 9): RawSignal[] {
  const signals: RawSignal[] = apps.map((app, index) => ({ kind: 'focus' as const, ts: at(day, hour, index * 5), app }));
  signals.push({ kind: 'idle_start', ts: at(day, hour, apps.length * 5) });
  return signals;
}

/** A working day with the planted routine. An intruder, when given, sits between Slack and Chrome. */
function plantedDay(day: number, intruder?: string): RawSignal[] {
  const apps = ['Microsoft Excel', 'Microsoft Outlook', 'Slack', ...(intruder ? [intruder] : []), 'Google Chrome'];
  return stretchOn(day, apps);
}

/** Normalised events, as capture produces them, with browsers watched. */
function eventsOf(signals: readonly RawSignal[]): TwinEvent[] {
  return signals
    .map((signal, index) => normalizeSignal(signal, { excludedApps: [], watchBrowsers: true, newId: () => `e${index}` }))
    .filter((event): event is TwinEvent => event !== null);
}

function routinesOf(signals: readonly RawSignal[]): Routine[] {
  return mineRoutines(segment(eventsOf(signals), GAP));
}

/** Every app a routine names, at any position, options included. */
function appsIn(routines: readonly Routine[]): string[] {
  return routines.flatMap(routine => routine.steps.flatMap(step => [step.app, ...step.options]));
}

describe('an unknown app that recurs', () => {
  const RECURRING = [0, 1, 2].flatMap(day => stretchOn(day, ['Google Chrome', 'Arc', 'Slack']));

  it('is its own step, and the routine names that app', () => {
    const routine = routinesOf(RECURRING).find(candidate => candidate.steps.length === 3);
    expect(routine?.steps.map(step => step.app)).toEqual(['google chrome', 'arc', 'slack']);
    expect(routine?.steps[1]).toMatchObject({ windowClass: 'other', options: ['arc'] });
    expect(routine).toMatchObject({ support: 3, days: 3 });
    expect(compileRoutine(routine!).name).toBe('Routine: browser → arc → chat');
  });

  it('is not mined when it is used on fewer than the minimum days', () => {
    const signals = [
      ...stretchOn(0, ['Google Chrome', 'Arc', 'Slack']),
      ...stretchOn(1, ['Google Chrome', 'Arc', 'Slack']),
      ...stretchOn(1, ['Google Chrome', 'Arc', 'Slack'], 14),
    ];
    expect(routinesOf(signals)).toEqual([]);
  });

  it('keeps two unknown apps at one position as separate steps', () => {
    const signals = [0, 1, 2].flatMap(day => stretchOn(day, ['Google Chrome', 'Arc', 'Zed', 'Slack']));
    const routine = routinesOf(signals).find(candidate => candidate.steps.length === 4);
    expect(routine?.steps.map(step => step.app)).toEqual(['google chrome', 'arc', 'zed', 'slack']);
    expect(routine?.steps.every(step => step.options.length === 1)).toBe(true);
  });

  it('does not merge two unknown apps that take the same position on different days', () => {
    const signals = [
      ...[0, 1, 2].flatMap(day => stretchOn(day, ['Google Chrome', 'Arc', 'Slack'])),
      ...[3, 4, 5].flatMap(day => stretchOn(day, ['Google Chrome', 'Zed', 'Slack'])),
    ];
    const routines = routinesOf(signals);
    expect(routines.map(routine => routine.steps[1].app).sort()).toEqual(['arc', 'zed']);
    expect(routines.every(routine => routine.steps[1].options.length === 1)).toBe(true);
  });

  it('counts in readiness as covered by its routine, not as not yet', () => {
    const events = eventsOf(Array.from({ length: 10 }, (_, day) => stretchOn(day, ['Google Chrome', 'Arc', 'Zed'])).flat());
    const readiness = computeReadiness({
      now: at(10, 0),
      events,
      idleGapMs: GAP,
      routines: mineRoutines(segment(events, GAP)),
      automations: [],
      dismissedRoutineIds: [],
    });
    expect(readiness.rows.find(row => row.app === 'arc')).toMatchObject({
      switches: 7,
      automatablePct: 100,
      status: 'automatable',
      routines: 1,
    });
  });
});

describe('what mining never reads', () => {
  /** Shells that the catalogue does not know. A catalogued terminal is mined as before, so it is not listed here. */
  const SHELLS = ['bash', 'zsh', 'sh', 'fish', 'pwsh', 'cmd', 'osascript', 'wscript', 'python3', 'node', 'perl'];
  const SYSTEM = [
    'Finder',
    'Dock',
    'loginwindow',
    'SystemUIServer',
    'Spotlight',
    'Control Center',
    'Window Server',
    'explorer',
    'ShellExperienceHost',
    'StartMenuExperienceHost',
    'SearchHost',
    'LockApp',
    'gnome-shell',
    'plasmashell',
    'kwin',
  ];

  it.each(SHELLS)('never mines the shell %s, even when it recurs', shell => {
    const routines = routinesOf([0, 1, 2].flatMap(day => plantedDay(day, shell)));
    expect(appsIn(routines)).not.toContain(shell);
    expect(routines.find(routine => routine.steps.length === 4)?.steps.map(step => step.app)).toEqual(PLANTED);
  });

  it.each(SYSTEM)('never mines the system process %s, even when it recurs', process => {
    const routines = routinesOf([0, 1, 2].flatMap(day => plantedDay(day, process)));
    expect(appsIn(routines)).not.toContain(process.toLowerCase());
    expect(routines.find(routine => routine.steps.length === 4)?.steps.map(step => step.app)).toEqual(PLANTED);
  });

  it.each(['1Password', 'Bitwarden', 'KeePassXC', 'Keychain Access'])('never mines the excluded app %s', app => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-unknown-apps-'));
    const agent = new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => at(10, 0) });
    try {
      agent.updateConfig({ watchBrowsers: true });
      for (const day of [0, 1, 2]) for (const signal of plantedDay(day, app)) agent.ingest(signal);
      const routines = agent.analyze().routines;
      expect(appsIn(routines)).not.toContain(app.toLowerCase());
      expect(routines.find(routine => routine.steps.length === 4)?.steps.map(step => step.app)).toEqual(PLANTED);
    } finally {
      agent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('lets a one-off unknown app pass without breaking the routine around it', () => {
    const routines = routinesOf([0, 1, 2, 3, 4].flatMap(day => plantedDay(day, `Random App ${day}`)));
    expect(routines.find(routine => routine.steps.length === 4)?.steps.map(step => step.app)).toEqual(PLANTED);
  });
});
