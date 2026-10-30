import { isExcludedApp } from './classify';
import { effectOfOp, type Step } from './automation';
import { FLOOR_EFFECTS, type AutonomyLevel, type EffectClass } from './types';

export type DecisionKind = 'allow' | 'ask' | 'deny';

export interface Decision {
  decision: DecisionKind;
  reason: string;
  effect: EffectClass;
}

export interface PolicyContext {
  level: AutonomyLevel;
  maxLevel: AutonomyLevel;
  /** True when no person is present to confirm. */
  unattended: boolean;
  excludedApps: readonly string[];
}

/**
 * Deterministic policy, evaluated before every step. It is ordinary code, not a prompt, so an
 * instruction read from a screen or a web page cannot change it.
 */
export function evaluateStep(step: Step, context: PolicyContext): Decision {
  const effect = effectOfOp(step.op, step.app);
  const deny = (reason: string): Decision => ({ decision: 'deny', reason, effect });

  if (isExcludedApp(step.app, context.excludedApps)) {
    return deny('This app is on your exclusion list, so the twin never touches it.');
  }
  if (context.level > context.maxLevel) return deny('Automation level is above the configured maximum.');
  if (context.level >= 5) return deny('Fully autonomous external actions are not part of this version.');
  if (context.level <= 2) return deny('Draft level: shown for review, not executed.');

  if (FLOOR_EFFECTS.includes(effect)) {
    if (context.unattended) return deny(`${effect} always needs a person present.`);
    return { decision: 'ask', reason: `${effect} needs your confirmation.`, effect };
  }
  if (context.unattended && context.level < 4) return deny('Unattended runs need level 4.');
  return { decision: 'allow', reason: 'Within the autonomy level.', effect };
}
