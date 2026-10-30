import { describe, expect, it } from 'vitest';
import {
  DAY_MS,
  initialState,
  promote,
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
