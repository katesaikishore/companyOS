import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  TwinAgent,
  compileRoutine,
  computeReadiness,
  effectsOf,
  initialState,
  mineRoutines,
  promotionCheck,
  segment,
  wholePercentages,
  type AppReadinessRow,
  type AutomationView,
  type TwinEvent,
  type WindowClass,
} from '../src';
import { SECRET_QUERY, at, workdays } from './fixtures';

const GAP = 60 * 60_000;
/** Midnight at the start of day 10. The seven-day window covers days 3 to 9. */
const NOW = at(10, 0);
const config = { maxLevel: 3 as const, allowUnattended: false };

let sequence = 0;

function focus(ts: number, app: string, windowClass: WindowClass): TwinEvent {
  sequence += 1;
  return { id: `e${sequence}`, ts, kind: 'focus', app, windowClass };
}

function idle(ts: number): TwinEvent {
  sequence += 1;
  return { id: `e${sequence}`, ts, kind: 'idle_start' };
}

/**
 * Planted routines, one stretch each. At nine, a local routine: spreadsheet, document, browser. At two, a mail
 * routine: spreadsheet, mail, chat. Each stretch ends with an idle marker, so the two never run together.
 */
function plantedDays(days: number): TwinEvent[] {
  return Array.from({ length: days }, (_, day) => [
    focus(at(day, 9), 'microsoft excel', 'spreadsheet'),
    focus(at(day, 9, 10), 'microsoft word', 'document'),
    focus(at(day, 9, 20), 'google chrome', 'browser'),
    idle(at(day, 9, 30)),
    focus(at(day, 14), 'microsoft excel', 'spreadsheet'),
    focus(at(day, 14, 10), 'microsoft outlook', 'mail'),
    focus(at(day, 14, 20), 'slack', 'chat'),
    idle(at(day, 14, 30)),
  ]).flat();
}

/** One lone switch a day to an app no routine uses. Each is followed by idle, so it never forms a sequence. */
function loneDays(days: number): TwinEvent[] {
  return Array.from({ length: days }, (_, day) => [focus(at(day, 17), 'figma', 'design'), idle(at(day, 17, 5))]).flat();
}

function readinessOf(events: TwinEvent[], now = NOW, automations: AutomationView[] = [], dismissedRoutineIds: string[] = []) {
  return computeReadiness({
    now,
    events,
    idleGapMs: GAP,
    routines: mineRoutines(segment(events, GAP)),
    automations,
    dismissedRoutineIds,
  });
}

function rowOf(readiness: ReturnType<typeof readinessOf>, app: string): AppReadinessRow {
  const row = readiness.rows.find(candidate => candidate.app === app);
  if (!row) throw new Error(`No row for ${app}`);
  return row;
}

const SAMPLE = [...plantedDays(10), ...loneDays(10)];

describe('attribution rule on planted fixtures', () => {
  it('counts the local routine as automatable', () => {
    const word = rowOf(readinessOf(SAMPLE), 'microsoft word');
    expect(word).toMatchObject({ switches: 7, automatablePct: 100, approvalPct: 0, notYetPct: 0, status: 'automatable' });
    expect(word.reason).toBe('Only local, reversible steps.');
  });

  it('counts the mail routine as approval, because mail and chat steps always ask', () => {
    const outlook = rowOf(readinessOf(SAMPLE), 'microsoft outlook');
    expect(outlook).toMatchObject({ switches: 7, automatablePct: 0, approvalPct: 100, notYetPct: 0, status: 'approval' });
    expect(outlook.reason).toBe('Mail and chat steps always ask.');
  });

  it('counts an app no routine uses as not yet', () => {
    const figma = rowOf(readinessOf(SAMPLE), 'figma');
    expect(figma).toMatchObject({ switches: 7, automatablePct: 0, approvalPct: 0, notYetPct: 100, status: 'not_yet', routines: 0 });
    expect(figma.reason).toBe('No repeated sequence yet.');
    expect(figma.learned).toEqual([]);
  });

  it('splits an app that sits in both kinds of routine, with the rounding applied per app', () => {
    const excel = rowOf(readinessOf(SAMPLE), 'microsoft excel');
    expect(excel).toMatchObject({ switches: 14, automatablePct: 50, approvalPct: 50, notYetPct: 0, status: 'partly' });
    expect(excel.reason).toBe('Local, reversible steps can run on their own. Mail and chat steps always ask.');
  });

  it('gives the overall split with largest-remainder rounding, summing to 100', () => {
    const readiness = readinessOf(SAMPLE);
    expect(readiness.switches).toBe(49);
    expect(readiness.apps).toBe(6);
    // 21 automatable, 21 approval and 7 not yet out of 49: the two .857 remainders take the spare points.
    expect([readiness.automatablePct, readiness.approvalPct, readiness.notYetPct]).toEqual([43, 43, 14]);
  });

  it('sums every row to exactly 100', () => {
    for (const row of readinessOf(SAMPLE).rows) {
      expect(row.automatablePct + row.approvalPct + row.notYetPct).toBe(100);
    }
  });

  it('sorts the rows by automatable share, then switches, then name', () => {
    const apps = readinessOf(SAMPLE).rows.map(row => row.app);
    expect(apps).toEqual(['google chrome', 'microsoft word', 'microsoft excel', 'figma', 'microsoft outlook', 'slack']);
  });

  it('does not depend on the order the events arrive in', () => {
    expect(readinessOf([...SAMPLE].reverse())).toEqual(readinessOf(SAMPLE));
  });
});

describe('the seven-day window', () => {
  it('counts only switches inside the window, but mines the routines from all of them', () => {
    const readiness = readinessOf(SAMPLE);
    const excel = rowOf(readiness, 'microsoft excel');
    expect(excel.learned.map(item => item.days)).toEqual([10, 10]);
    // Days 0 to 2 are outside the window, so they add no switches.
    expect(readiness.switches).toBe(49);
  });

  it('reports the routine switch count only for switches in the window', () => {
    const outlook = rowOf(readinessOf(SAMPLE), 'microsoft outlook');
    expect(outlook.learned[0]).toMatchObject({ sequence: 'microsoft excel → microsoft outlook → slack', switches: 7, kind: 'approval' });
  });

  it('finds no routine in two days of data, so every switch is not yet', () => {
    // Two days is below the three-day minimum, so nothing is mined and all twelve switches fall outside any routine.
    const readiness = readinessOf(plantedDays(2), at(2, 0));
    expect(readiness.switches).toBe(12);
    expect(readiness.notYetPct).toBe(100);
    expect(readiness.rows.every(row => row.status === 'not_yet')).toBe(true);
  });

  it('reports no switches when the window holds none', () => {
    const readiness = readinessOf(plantedDays(2), at(20, 0));
    expect(readiness).toEqual({ switches: 0, apps: 0, automatablePct: 0, approvalPct: 0, notYetPct: 0, rows: [] });
  });
});

describe('empty input', () => {
  it('reports zero switches, no apps and zero percentages', () => {
    expect(readinessOf([])).toEqual({ switches: 0, apps: 0, automatablePct: 0, approvalPct: 0, notYetPct: 0, rows: [] });
  });
});

describe('dismissed routines', () => {
  it('still count in the figures, and the routine is marked dismissed', () => {
    const routine = mineRoutines(segment(SAMPLE, GAP)).find(candidate => candidate.steps[0].windowClass === 'spreadsheet' && candidate.steps[1].windowClass === 'document');
    const readiness = readinessOf(SAMPLE, NOW, [], [routine!.id]);
    expect(rowOf(readiness, 'microsoft word').learned[0].status).toBe('dismissed');
    expect(readiness.automatablePct).toBe(43);
  });
});

describe('promotion gate for an accepted automation', () => {
  /** The local routine, accepted as a draft at level 2, the way Suggestions accepts it. */
  function acceptedLocalRoutine(): AutomationView {
    const routine = mineRoutines(segment(SAMPLE, GAP)).find(
      candidate => candidate.steps.map(step => step.windowClass).join('>') === 'spreadsheet>document>browser',
    );
    const automation = compileRoutine(routine!);
    const state = initialState(automation.id, effectsOf(automation));
    return { automation, state, promotion: promotionCheck(state, NOW, config) };
  }

  it('shows the gate, with the promotion result of the automation, for the apps of an accepted routine', () => {
    const view = acceptedLocalRoutine();
    const word = rowOf(readinessOf(SAMPLE, NOW, [view]), 'microsoft word');
    expect(word.gate).toEqual({
      automationId: view.automation.id,
      automationName: view.automation.name,
      level: 2,
      requirements: view.promotion.requirements,
    });
    expect(word.learned[0]).toMatchObject({ status: 'accepted', level: 2, automationName: view.automation.name });
  });

  it('shows no gate for an app whose routine was not accepted', () => {
    expect(rowOf(readinessOf(SAMPLE, NOW, [acceptedLocalRoutine()]), 'microsoft outlook').gate).toBeUndefined();
  });

  it('reports real values and no invented ones, before any run', () => {
    const view = acceptedLocalRoutine();
    const requirements = rowOf(readinessOf(SAMPLE, NOW, [view]), 'microsoft word').gate!.requirements;
    const find = (label: string) => requirements.find(requirement => requirement.label === label);
    expect(find('Level 3, one-click run first')).toMatchObject({ value: 'L2', met: false });
    expect(find('Unattended runs switched on in settings')).toMatchObject({ value: 'Off', met: false });
    expect(find('Every effect local and reversible')).toMatchObject({ value: 'Yes', met: true });
    expect(find('Supervised runs at level 3')).toMatchObject({ value: '0 / 10', met: false, progress: 0 });
    expect(find('Runs in the last 14 days')).toMatchObject({ value: '0 / 25', met: false, progress: 0 });
    expect(find('Pass rate in the last 14 days')).toMatchObject({ value: 'No checks yet', met: false });
    expect(requirements.filter(requirement => !requirement.met).map(requirement => requirement.reason)).toEqual(view.promotion.reasons);
  });
});

describe('wholePercentages', () => {
  it('rounds to whole numbers that sum to 100', () => {
    expect(wholePercentages([1, 1, 1])).toEqual([34, 33, 33]);
    expect(wholePercentages([2, 1])).toEqual([67, 33]);
    expect(wholePercentages([21, 21, 7])).toEqual([43, 43, 14]);
    expect(wholePercentages([7, 0, 0])).toEqual([100, 0, 0]);
  });

  it('returns zeros when there is nothing to split', () => {
    expect(wholePercentages([0, 0, 0])).toEqual([0, 0, 0]);
  });
});

describe('readiness from the agent', () => {
  it('reads the routines Suggestions uses, and holds nothing but app names and timing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'twin-readiness-'));
    const agent = new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => at(10, 0) });
    agent.updateConfig({ watchBrowsers: true });
    for (const signal of workdays(10)) agent.ingest(signal);

    const readiness = agent.readiness();
    const serialized = JSON.stringify(readiness);
    agent.close();

    expect(readiness.switches).toBeGreaterThan(0);
    expect(readiness.automatablePct + readiness.approvalPct + readiness.notYetPct).toBe(100);
    // The Outlook and Slack steps sit in a routine with mail and chat, so the whole routine asks.
    expect(rowOf(readiness, 'microsoft outlook').status).toBe('approval');
    expect(rowOf(readiness, 'slack').reason).toBe('Mail and chat steps always ask.');
    // A random app per day is never part of a repeated sequence.
    expect(rowOf(readiness, 'random app 4').status).toBe('not_yet');
    expect(serialized).not.toContain(SECRET_QUERY);
    expect(serialized).not.toContain('token=');
  });
});

describe('readiness with sites', () => {
  it('covers a routine whose two browser steps are different sites in a row, as mining keys them', () => {
    const stream = Array.from({ length: 5 }, (_, day) => [
      focus(at(day, 9), 'microsoft excel', 'spreadsheet'),
      { ...focus(at(day, 9, 10), 'google chrome', 'browser'), urlTemplate: 'mail.google.com/mail' },
      { ...focus(at(day, 9, 20), 'google chrome', 'browser'), urlTemplate: 'docs.google.com/spreadsheets' },
      focus(at(day, 9, 30), 'microsoft word', 'document'),
      idle(at(day, 9, 40)),
    ]).flat();

    const row = rowOf(readinessOf(stream, at(5, 0)), 'google chrome');
    expect(row).toMatchObject({ status: 'automatable', automatablePct: 100, routines: 1 });
  });
});
