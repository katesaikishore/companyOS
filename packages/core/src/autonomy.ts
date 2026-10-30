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

/** The only effects that may run unattended. Every other effect needs a person, at every level. */
export const LOCAL_EFFECTS: readonly EffectClass[] = ['read_only', 'local_reversible'];

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

/** One condition of the promotion gate, with the value the automation has now. */
export interface GateRequirement {
  /** The condition, in plain words. */
  label: string;
  /** The current value, as the checklist shows it. */
  value: string;
  met: boolean;
  /** Progress toward a count, from 0 to 1. Only counts have one. */
  progress?: number;
  /** What the gate says while this condition is not met. */
  reason: string;
}

/**
 * Lists every unmet condition. An empty list means the automation may move to level 4. The reasons are the unmet
 * requirements, so the checklist and the reasons are built from the same conditions and cannot disagree.
 */
export function promotionCheck(
  state: AutonomyState,
  now: number,
  config: AutonomyConfig,
): { eligible: boolean; reasons: string[]; passRate?: number; requirements: GateRequirement[] } {
  const { requirements, passRate } = gateRequirements(state, now, config);
  const reasons = requirements.filter(requirement => !requirement.met).map(requirement => requirement.reason);
  return { eligible: reasons.length === 0, reasons, passRate, requirements };
}

/** Every condition for level 4, met or not, in the order the gate checks them, with the window's pass rate. */
function gateRequirements(
  state: AutonomyState,
  now: number,
  config: AutonomyConfig,
): { requirements: GateRequirement[]; passRate?: number } {
  const { minSupervisedRuns, windowDays, minRunsInWindow, minPassRate } = PROMOTION_RULES;
  const windowStart = now - windowDays * DAY_MS;
  const recent = state.runs.filter(run => run.ts >= windowStart);
  const supervised = state.runs.filter(run => run.mode === 'supervised' && run.level === 3).length;

  const passed = recent.reduce((sum, run) => sum + run.postconditionsPassed, 0);
  const failedChecks = recent.reduce((sum, run) => sum + run.postconditionsFailed, 0);
  const passRate = passed + failedChecks === 0 ? undefined : passed / (passed + failedChecks);
  const reverted = recent.filter(run => run.reverted).length;
  const failed = recent.filter(run => run.status === 'failed').length;
  const unattended = config.maxLevel >= 4 && config.allowUnattended;
  const local = state.effects.every(effect => LOCAL_EFFECTS.includes(effect));
  const targetRate = `${Math.round(minPassRate * 100)}%`;

  const requirements: GateRequirement[] = [
    {
      label: 'Level 3, one-click run first',
      value: `L${state.level}`,
      met: state.level === 3,
      reason: 'It must first run at level 3 (one-click run).',
    },
    {
      label: 'Unattended runs switched on in settings',
      value: unattended ? 'On' : 'Off',
      met: unattended,
      reason: 'Unattended runs are switched off in settings.',
    },
    {
      label: 'Every effect local and reversible',
      value: local ? 'Yes' : 'No',
      met: local,
      reason: 'Some of its effects can never run unattended.',
    },
    {
      label: 'Supervised runs at level 3',
      value: `${supervised} / ${minSupervisedRuns}`,
      met: supervised >= minSupervisedRuns,
      progress: Math.min(1, supervised / minSupervisedRuns),
      reason: `Needs ${minSupervisedRuns - supervised} more supervised runs.`,
    },
    {
      label: `Runs in the last ${windowDays} days`,
      value: `${recent.length} / ${minRunsInWindow}`,
      met: recent.length >= minRunsInWindow,
      progress: Math.min(1, recent.length / minRunsInWindow),
      reason: `Needs ${minRunsInWindow - recent.length} more runs in the last ${windowDays} days.`,
    },
    {
      label: `Pass rate in the last ${windowDays} days`,
      value: passRate === undefined ? 'No checks yet' : `${(passRate * 100).toFixed(1)}% / ${targetRate}`,
      met: passRate !== undefined && passRate >= minPassRate,
      reason:
        passRate === undefined
          ? 'No postcondition results yet.'
          : `Postcondition pass rate is ${(passRate * 100).toFixed(1)}%; it must be at least ${targetRate}.`,
    },
    {
      label: `No revert in the last ${windowDays} days`,
      value: reverted === 0 ? 'None' : `${reverted} reverted`,
      met: reverted === 0,
      reason: 'A run in the window was reverted.',
    },
    {
      label: `No failed run in the last ${windowDays} days`,
      value: failed === 0 ? 'None' : `${failed} failed`,
      met: failed === 0,
      // A failure is not forgiven by a later promote(). The window must be clean, so a demotion has to be re-earned.
      reason: 'A run in the window failed.',
    },
  ];
  return { requirements, passRate };
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
