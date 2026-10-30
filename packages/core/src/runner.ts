import { normalizeAppName } from './classify';
import { resolveStep, type Automation, type Step } from './automation';
import { evaluateStep, type Decision, type PolicyContext } from './policy';
import type { AutonomyLevel } from './types';

/** The only side-effecting surface the runner touches. Tests supply a fake; the desktop app supplies the OS. */
export interface Executor {
  focusApp(app: string): Promise<boolean>;
  frontmostApp(): Promise<string | undefined>;
}

export type RunMode = 'dry_run' | 'supervised' | 'unattended';

export type StepOutcome = 'dry_run' | 'executed' | 'passed' | 'check_failed' | 'blocked' | 'failed';

export interface StepRecord {
  index: number;
  op: Step['op'];
  app: string;
  outcome: StepOutcome;
  reason: string;
}

export interface RunResult {
  status: 'dry_run' | 'completed' | 'blocked' | 'failed';
  steps: StepRecord[];
  postconditionsPassed: number;
  postconditionsFailed: number;
}

export interface RunRequest {
  mode: RunMode;
  values?: Readonly<Record<string, string>>;
  policy: PolicyContext;
  /** Read before every step, so a level change made during the run (a kill switch) takes effect at once. */
  currentLevel?: () => AutonomyLevel;
  /** Re-read privacy and autonomy settings before every step and after every approval wait. */
  currentPolicy?: () => PolicyContext;
  /** A global stop request cancels steps that have not started, even if automations are turned back on. */
  shouldStop?: () => boolean;
  /** Called only for steps the policy marks 'ask', and only in supervised mode. */
  approve?: (step: Step, decision: Decision) => Promise<boolean>;
}

function sameApp(observed: string | undefined, expected: string): boolean {
  return observed !== undefined && normalizeAppName(observed) === normalizeAppName(expected);
}

/**
 * Runs an automation step by step. Dry runs never call the executor and show what would happen
 * at the next level up. Any denied step, refused approval, failed action or failed postcondition
 * stops the run. Parameter values are checked before the first step, so a bad value runs nothing.
 */
export async function runAutomation(automation: Automation, request: RunRequest, executor: Executor): Promise<RunResult> {
  const values = request.values ?? {};
  const resolved = automation.steps.map(template => resolveStep(template, automation.params, values));

  const steps: StepRecord[] = [];
  let passed = 0;
  let failed = 0;

  const finish = (status: RunResult['status']): RunResult => ({
    status,
    steps,
    postconditionsPassed: passed,
    postconditionsFailed: failed,
  });

  for (const [index, step] of resolved.entries()) {
    const record = (outcome: StepOutcome, reason: string): void => {
      steps.push({ index, op: step.op, app: step.app, outcome, reason });
    };

    if (request.mode === 'dry_run') {
      // Shown as if the owner had raised the level to run it, so the preview names every approval it would need.
      const preview = evaluateStep(step, { ...request.policy, level: 3, unattended: false });
      record('dry_run', preview.reason);
      continue;
    }

    let approved = false;
    let decision: Decision;
    for (;;) {
      if (request.shouldStop?.()) {
        record('blocked', 'Automations were stopped.');
        return finish('blocked');
      }

      const livePolicy = request.currentPolicy?.() ?? {
        ...request.policy,
        level: request.currentLevel ? request.currentLevel() : request.policy.level,
      };
      decision = evaluateStep(step, { ...livePolicy, unattended: request.mode === 'unattended' });
      if (decision.decision === 'deny') {
        record('blocked', decision.reason);
        return finish('blocked');
      }
      if (decision.decision !== 'ask' || approved) break;

      approved = request.approve ? await request.approve(step, decision) : false;
      if (!approved) {
        record('blocked', 'Not approved.');
        return finish('blocked');
      }
      // Settings may have changed while the native approval dialog was open. Loop and re-check them.
    }

    if (step.op === 'focus_app') {
      let ok = false;
      try {
        ok = await executor.focusApp(step.app);
      } catch {
        ok = false; // A thrown error is an ordinary failure. Its text may contain paths or scripts, so it is not kept.
      }
      if (!ok) {
        record('failed', 'The app could not be focused.');
        return finish('failed');
      }
      record('executed', decision.reason);
      continue;
    }

    let front: string | undefined;
    try {
      front = await executor.frontmostApp();
    } catch {
      front = undefined;
    }
    if (sameApp(front, step.app)) {
      passed++;
      record('passed', 'Expected app is in front.');
    } else {
      failed++;
      record('check_failed', 'A different app is in front.');
      return finish('failed');
    }
  }
  return finish(request.mode === 'dry_run' ? 'dry_run' : 'completed');
}
