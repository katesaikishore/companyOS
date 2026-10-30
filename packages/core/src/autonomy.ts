import type { RunResult } from './runner';
import type { AutonomyLevel, EffectClass } from './types';

export const DAY_MS = 86_400_000;

/** Design thresholds for earning unattended runs. These are recommendations, not sourced standards. */
export const PROMOTION_RULES = {
  minSupervisedRuns: 10,
  windowDays: 14,
  minRunsInWindow: 25,
  minPassRate: 0.99,
} as const;

export interface RunRecord {
  ts: number;
  mode: 'supervised' | 'unattended';
  level: AutonomyLevel;
  status: RunResult['status'];
  postconditionsPassed: number;
  postconditionsFailed: number;
  reverted: boolean;
}

export interface AutonomyState {
  automationId: string;
  level: AutonomyLevel;
  effects: EffectClass[];
  runs: RunRecord[];
}

export interface AutonomyConfig {
  maxLevel: AutonomyLevel;
  allowUnattended: boolean;
}

const LOCAL_EFFECTS: readonly EffectClass[] = ['read_only', 'local_reversible'];

/** New automations start as drafts (level 2). Nothing runs until the person raises the level. */
export function initialState(automationId: string, effects: EffectClass[]): AutonomyState {
  return { automationId, level: 2, effects, runs: [] };
}

/** A failed run, or a run the person reverted, drops the automation to level 3. */
export function recordRun(state: AutonomyState, run: RunRecord): AutonomyState {
  const runs = [...state.runs, run].slice(-500);
  const demote = run.status === 'failed' || run.reverted;
  const level = demote ? (Math.min(state.level, 3) as AutonomyLevel) : state.level;
  return { ...state, runs, level };
}

/** Lists every unmet condition. An empty list means the automation may move to level 4. */
export function promotionCheck(
  state: AutonomyState,
  now: number,
  config: AutonomyConfig,
): { eligible: boolean; reasons: string[]; passRate?: number } {
  const reasons: string[] = [];
  if (state.level !== 3) reasons.push('It must first run at level 3 (one-click run).');
  if (config.maxLevel < 4 || !config.allowUnattended) reasons.push('Unattended runs are switched off in settings.');
  if (state.effects.some(effect => !LOCAL_EFFECTS.includes(effect))) {
    reasons.push('Some of its effects can never run unattended.');
  }

  const supervised = state.runs.filter(run => run.mode === 'supervised' && run.level === 3).length;
  if (supervised < PROMOTION_RULES.minSupervisedRuns) {
    reasons.push(`Needs ${PROMOTION_RULES.minSupervisedRuns - supervised} more supervised runs.`);
  }

  const windowStart = now - PROMOTION_RULES.windowDays * DAY_MS;
  const recent = state.runs.filter(run => run.ts >= windowStart);
  if (recent.length < PROMOTION_RULES.minRunsInWindow) {
    reasons.push(`Needs ${PROMOTION_RULES.minRunsInWindow - recent.length} more runs in the last ${PROMOTION_RULES.windowDays} days.`);
  }

  const passed = recent.reduce((sum, run) => sum + run.postconditionsPassed, 0);
  const failed = recent.reduce((sum, run) => sum + run.postconditionsFailed, 0);
  const passRate = passed + failed === 0 ? undefined : passed / (passed + failed);
  if (passRate === undefined) {
    reasons.push('No postcondition results yet.');
  } else if (passRate < PROMOTION_RULES.minPassRate) {
    reasons.push(`Postcondition pass rate is ${(passRate * 100).toFixed(1)}%; it must be at least 99%.`);
  }

  if (recent.some(run => run.reverted)) reasons.push('A run in the window was reverted.');
  return { eligible: reasons.length === 0, reasons, passRate };
}

export function promote(state: AutonomyState, now: number, config: AutonomyConfig): AutonomyState {
  const check = promotionCheck(state, now, config);
  if (!check.eligible) throw new Error(`Not eligible for level 4: ${check.reasons.join(' ')}`);
  return { ...state, level: 4 };
}

/** Manual changes. Level 4 is reachable only through promote(), and level 5 is not in this version. */
export function setLevel(state: AutonomyState, level: AutonomyLevel, config: AutonomyConfig): AutonomyState {
  if (level === 5) throw new Error('Level 5 is not part of this version.');
  if (level === 4) throw new Error('Level 4 is granted only by promotion.');
  if (level > config.maxLevel) throw new Error('Above the configured maximum.');
  return { ...state, level };
}
