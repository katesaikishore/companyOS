import { normalizeAppName } from './classify';
import { resolveStep, type Automation, type Step } from './automation';
import { evaluateStep, type Decision, type PolicyContext } from './policy';

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
  /** Called only for steps the policy marks 'ask', and only in supervised mode. */
  approve?: (step: Step, decision: Decision) => Promise<boolean>;
}

function sameApp(observed: string | undefined, expected: string): boolean {
  return observed !== undefined && normalizeAppName(observed) === normalizeAppName(expected);
}

/**
 * Runs an automation step by step. Dry runs never call the executor and show what would happen
 * at the next level up. Any denied step, refused approval, failed action or failed postcondition
 * stops the run.
 */
export async function runAutomation(automation: Automation, request: RunRequest, executor: Executor): Promise<RunResult> {
  const steps: StepRecord[] = [];
  const values = request.values ?? {};
  let passed = 0;
  let failed = 0;

  const finish = (status: RunResult['status']): RunResult => ({
    status,
    steps,
    postconditionsPassed: passed,
    postconditionsFailed: failed,
  });

  for (const [index, template] of automation.steps.entries()) {
    const step = resolveStep(template, automation.params, values);
    const record = (outcome: StepOutcome, reason: string): void => {
      steps.push({ index, op: step.op, app: step.app, outcome, reason });
    };

    if (request.mode === 'dry_run') {
      // Shown as if the owner had raised the level to run it, so the preview names every approval it would need.
      const preview = evaluateStep(step, { ...request.policy, level: 3, unattended: false });
      record('dry_run', preview.reason);
      continue;
    }

    const decision = evaluateStep(step, { ...request.policy, unattended: request.mode === 'unattended' });
    if (decision.decision === 'deny') {
      record('blocked', decision.reason);
      return finish('blocked');
    }
    if (decision.decision === 'ask') {
      const approved = request.approve ? await request.approve(step, decision) : false;
      if (!approved) {
        record('blocked', 'Not approved.');
        return finish('blocked');
      }
    }

    if (step.op === 'focus_app') {
      const ok = await executor.focusApp(step.app);
      if (!ok) {
        record('failed', 'The app could not be focused.');
        return finish('failed');
      }
      record('executed', decision.reason);
      continue;
    }

    const front = await executor.frontmostApp();
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
