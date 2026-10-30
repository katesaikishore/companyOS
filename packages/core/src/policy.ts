import { classifyApp, effectOfOp, isExcludedApp } from './classify';
import { isSafeFilePath, parseKeyChord, parseWebAddress, type Step } from './automation';
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

  // The schema checks the same rules when an automation loads. Checking again here covers a step built some other way.
  const malformed = malformedReason(step);
  if (malformed) return deny(malformed);

  // A file is opened only when the person approves that exact path for this run. No unattended run has a person to ask.
  if (step.op === 'open_file') {
    if (context.unattended) return deny('Opening a file needs a person to approve that exact file, so it never runs unattended.');
    return { decision: 'ask', reason: 'Opening a file needs your confirmation for this exact file.', effect };
  }

  if (FLOOR_EFFECTS.includes(effect)) {
    if (context.unattended) return deny(`${effect} always needs a person present.`);
    return { decision: 'ask', reason: `${effect} needs your confirmation.`, effect };
  }
  if (context.unattended && context.level < 4) return deny('Unattended runs need level 4.');
  return { decision: 'allow', reason: 'Within the autonomy level.', effect };
}

/** Why a step's own content is not allowed, or undefined when it is. */
function malformedReason(step: Step): string | undefined {
  switch (step.op) {
    case 'open_url':
      if (!parseWebAddress(step.url)) return 'Only http and https addresses with no login, query or fragment can open.';
      return classifyApp(step.app) === 'browser' ? undefined : 'Links open only in a web browser.';
    case 'open_file':
      return isSafeFilePath(step.path) ? undefined : 'Only one exact file path can open: absolute, not a folder, not a program.';
    case 'press_shortcut':
      return parseKeyChord(step.shortcut) === step.shortcut ? undefined : 'Only a key chord with a modifier and one key can be pressed.';
    default:
      return undefined;
  }
}
