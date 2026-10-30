import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  initialState,
  promote,
  PROMOTION_RULES,
  promotionCheck,
  recordRun,
  setLevel,
  type AutonomyState,
  type RunRecord,
} from '../src';

const NOW = Date.UTC(2026, 9, 30);
const config = { maxLevel: 4 as const, allowUnattended: true };

function run(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    ts: NOW - DAY_MS,
    mode: 'supervised',
    level: 3,
    status: 'completed',
    postconditionsPassed: 4,
    postconditionsFailed: 0,
    reverted: false,
    ...overrides,
  };
}

function readyState(): AutonomyState {
  const runs = Array.from({ length: 30 }, () => run());
  return { ...initialState('a', ['read_only']), level: 3, runs };
}

describe('promotion gate', () => {
  it('is eligible when every condition holds', () => {
    const check = promotionCheck(readyState(), NOW, config);
    expect(check.eligible).toBe(true);
    expect(check.passRate).toBe(1);
  });

  it('needs ten supervised runs at level 3', () => {
    const state = { ...readyState(), runs: Array.from({ length: 25 }, () => run({ mode: 'unattended' })) };
    expect(promotionCheck(state, NOW, config).reasons.join(' ')).toMatch(/supervised runs/);
  });

  it('needs a pass rate of at least 99%', () => {
    const runs = Array.from({ length: 30 }, () => run({ postconditionsPassed: 98, postconditionsFailed: 2 }));
    const check = promotionCheck({ ...readyState(), runs }, NOW, config);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/pass rate/);
  });

  it('blocks when a run in the window was reverted', () => {
    const runs = [...readyState().runs.slice(1), run({ reverted: true })];
    expect(promotionCheck({ ...readyState(), runs }, NOW, config).reasons.join(' ')).toMatch(/reverted/);
  });

  it('never allows effects that need a person', () => {
    const check = promotionCheck({ ...readyState(), effects: ['external_effect'] }, NOW, config);
    expect(check.reasons.join(' ')).toMatch(/can never run unattended/);
  });

  it('stays off while unattended runs are disabled in settings', () => {
    const check = promotionCheck(readyState(), NOW, { maxLevel: 3, allowUnattended: false });
    expect(check.eligible).toBe(false);
  });

  it('promote throws until eligible, then reaches level 4', () => {
    expect(() => promote({ ...readyState(), runs: [] }, NOW, config)).toThrow(/Not eligible/);
    expect(promote(readyState(), NOW, config).level).toBe(4);
  });
});

describe('demotion and manual levels', () => {
  it('a failed run drops level 4 back to 3', () => {
    const state = { ...readyState(), level: 4 as const };
    expect(recordRun(state, run({ status: 'failed', postconditionsFailed: 1 })).level).toBe(3);
  });

  it('a successful run keeps the level', () => {
    const state = { ...readyState(), level: 4 as const };
    expect(recordRun(state, run()).level).toBe(4);
  });

  it('level 4 can only come from promotion, and level 5 is refused', () => {
    expect(() => setLevel(readyState(), 4, config)).toThrow(/only by promotion/);
    expect(() => setLevel(readyState(), 5, config)).toThrow(/not part of this version/);
    expect(() => setLevel(readyState(), 3, { maxLevel: 2, allowUnattended: false })).toThrow(/maximum/);
  });
});

describe('failure history', () => {
  it('a failed run in the window blocks promotion until the window is clean', () => {
    const runs = [...Array.from({ length: 30 }, () => run()), run({ status: 'failed', postconditionsPassed: 3, postconditionsFailed: 1 })];
    const check = promotionCheck({ ...readyState(), runs }, NOW, config);
    expect(check.eligible).toBe(false);
    expect(check.reasons.join(' ')).toMatch(/failed/);
  });

  it('a demoted automation cannot be promoted straight back', () => {
    const demoted = recordRun({ ...readyState(), level: 4 }, run({ status: 'failed', postconditionsPassed: 0, postconditionsFailed: 1 }));
    expect(demoted.level).toBe(3);
    expect(() => promote(demoted, NOW, config)).toThrow(/failed/);
  });
});

describe('gate checklist', () => {
  it('lists every condition, and the reasons are exactly the unmet ones', () => {
    const state = { ...initialState('a', ['read_only']), runs: Array.from({ length: 3 }, () => run()) };
    const check = promotionCheck(state, NOW, config);
    expect(check.requirements.filter(requirement => !requirement.met).map(requirement => requirement.reason)).toEqual(check.reasons);
    expect(check.requirements.every(requirement => requirement.met)).toBe(false);
  });

  it('shows the current count against each target', () => {
    const state = { ...initialState('a', ['read_only']), runs: Array.from({ length: 3 }, () => run()) };
    const supervised = promotionCheck(state, NOW, config).requirements.find(requirement => requirement.label === 'Supervised runs at level 3');
    expect(supervised).toMatchObject({ value: '3 / 10', met: false, progress: 0.3 });
    expect(promotionCheck(state, NOW, config).reasons).toContain('Needs 7 more supervised runs.');
  });

  it('is met everywhere when the automation is eligible', () => {
    const check = promotionCheck(readyState(), NOW, config);
    expect(check.requirements.every(requirement => requirement.met)).toBe(true);
    expect(check.requirements.find(requirement => requirement.label.startsWith('Pass rate'))).toMatchObject({ value: '100.0% / 99%', met: true });
  });

  it('a level-4 automation meets every condition, with none open', () => {
    const check = promotionCheck({ ...readyState(), level: 4 as const }, NOW, config);
    const met = check.requirements.filter(requirement => requirement.met);
    expect(check.requirements.find(requirement => requirement.label === 'Level 3, one-click run first')).toMatchObject({ value: 'L4', met: true });
    expect(met).toHaveLength(8);
    expect(met).toHaveLength(check.requirements.length);
    expect(check.reasons).toEqual([]);
    expect(check.eligible).toBe(true);
  });

  it('keeps the supervised-run condition met at level 4 once those runs fall out of the history', () => {
    const runs = Array.from({ length: 30 }, () => run({ mode: 'unattended', level: 4 }));
    const check = promotionCheck({ ...initialState('a', ['read_only']), level: 4 as const, runs }, NOW, config);
    expect(check.requirements.find(requirement => requirement.label === 'Supervised runs at level 3')).toMatchObject({ met: true });
    expect(check.eligible).toBe(true);
  });

  it('keeps the level-3 condition open below level 3', () => {
    const check = promotionCheck({ ...readyState(), level: 2 as const }, NOW, config);
    expect(check.requirements.find(requirement => requirement.label === 'Level 3, one-click run first')).toMatchObject({ value: 'L2', met: false });
    expect(check.reasons).toContain('It must first run at level 3 (one-click run).');
  });

  it('reads one more run in the singular', () => {
    const oneSupervised = { ...initialState('a', ['read_only']), runs: Array.from({ length: 9 }, () => run()) };
    expect(promotionCheck(oneSupervised, NOW, config).reasons).toContain('Needs 1 more supervised run.');
    const oneInWindow = { ...initialState('a', ['read_only']), runs: Array.from({ length: 24 }, () => run()) };
    expect(promotionCheck(oneInWindow, NOW, config).reasons).toContain(`Needs 1 more run in the last ${PROMOTION_RULES.windowDays} days.`);
  });

  it('reads runs in the plural for any other count', () => {
    const state = { ...initialState('a', ['read_only']), runs: Array.from({ length: 3 }, () => run()) };
    expect(promotionCheck(state, NOW, config).reasons).toContain(`Needs 22 more runs in the last ${PROMOTION_RULES.windowDays} days.`);
  });
});
