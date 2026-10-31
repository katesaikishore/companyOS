import { normalizeAppName } from './classify';
import { parseWebAddress, resolveStep, type Automation, type Step } from './automation';
import { evaluateStep, type Decision, type PolicyContext } from './policy';
import type { AutonomyLevel } from './types';

/**
 * The only side-effecting surface the runner touches. Tests supply a fake; the desktop app supplies the OS.
 * The three optional methods are steps an adapter may not support. A missing method blocks that step before anyone
 * is asked. A block is not a failure, so it does not demote the automation.
 */
export interface Executor {
  focusApp(app: string): Promise<boolean>;
  frontmostApp(): Promise<string | undefined>;
  /** Opens an allowed http or https address, in canonical form, in the named browser. */
  openUrl?(app: string, url: string): Promise<boolean>;
  /** Opens one checked file in the named application. */
  openFile?(app: string, path: string): Promise<boolean>;
  /**
   * Presses a checked key chord in the named application. The adapter must bring that application forward and send the
   * keys only once it is in front, and return false otherwise. The runner cannot check this itself: the approval dialog
   * takes focus, so a check made before approval would be wrong by the time the keys are sent.
   */
  pressShortcut?(app: string, shortcut: string): Promise<boolean>;
  /**
   * Why this executor cannot carry out a focus or key step right now, or undefined when it can. The runner asks only for
   * those two steps, before anyone is asked, and a reason blocks the step. The desktop app uses it when its optional
   * agent-desktop program is set but unusable.
   */
  blockedReason?(op: 'focus_app' | 'press_shortcut'): string | undefined;
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
  /**
   * How long the postcondition of an open or key step waits for the OS to bring the expected app forward. Focus
   * can take a moment to move. Defaults to 1.5 seconds. Tests set it to 0.
   */
  settleMs?: number;
}

const DEFAULT_SETTLE_MS = 1_500;
const SETTLE_POLL_MS = 150;

const FAILED_REASON = {
  open_url: 'The address could not be opened.',
  open_file: 'The file could not be opened.',
  press_shortcut: 'The shortcut could not be pressed.',
} as const;

function sameApp(observed: string | undefined, expected: string): boolean {
  return observed !== undefined && normalizeAppName(observed) === normalizeAppName(expected);
}

/** Why this system cannot carry out a step at all, or undefined when it can. */
function unsupportedReason(step: Step, executor: Executor): string | undefined {
  if (step.op === 'focus_app' || step.op === 'press_shortcut') {
    const blocked = executor.blockedReason?.(step.op);
    if (blocked) return blocked;
  }
  if (step.op === 'open_url' && !executor.openUrl) return 'This system cannot open web addresses yet.';
  if (step.op === 'open_file' && !executor.openFile) return 'This system cannot open files yet.';
  if (step.op === 'press_shortcut' && !executor.pressShortcut) return 'This system cannot press shortcuts yet.';
  return undefined;
}

/** Carries out one open or key step. A thrown error is an ordinary failure, as with focusApp. */
async function perform(step: Step, executor: Executor): Promise<boolean> {
  try {
    switch (step.op) {
      case 'open_url': {
        const url = parseWebAddress(step.url);
        return url !== undefined && (await executor.openUrl?.(step.app, url.href)) === true;
      }
      case 'open_file':
        return (await executor.openFile?.(step.app, step.path)) === true;
      case 'press_shortcut':
        return (await executor.pressShortcut?.(step.app, step.shortcut)) === true;
      default:
        return false;
    }
  } catch {
    return false;
  }
}

/** True when the expected app is in front, looking again for up to budgetMs because the OS may take a moment. */
async function settlesInFront(executor: Executor, app: string, budgetMs: number): Promise<boolean> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    let front: string | undefined;
    try {
      front = await executor.frontmostApp();
    } catch {
      front = undefined;
    }
    if (sameApp(front, app)) return true;
    if (Date.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, SETTLE_POLL_MS));
  }
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

    // Refused before anyone is asked, so a person is never asked to approve a step that cannot run.
    const unsupported = unsupportedReason(step, executor);
    if (unsupported) {
      record('blocked', unsupported);
      return finish('blocked');
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

    if (step.op === 'open_url' || step.op === 'open_file' || step.op === 'press_shortcut') {
      // One action, then its postcondition: the expected app is in front once the action has run.
      if (!(await perform(step, executor))) {
        record('failed', FAILED_REASON[step.op]);
        return finish('failed');
      }
      if (await settlesInFront(executor, step.app, request.settleMs ?? DEFAULT_SETTLE_MS)) {
        passed++;
        record('passed', 'Done. The expected app is in front.');
        continue;
      }
      failed++;
      record('check_failed', 'A different app is in front.');
      return finish('failed');
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
