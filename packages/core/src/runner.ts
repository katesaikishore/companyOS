import { normalizeAppName } from './classify';
import { parseWebAddress, resolveStep, type Automation, type Locator, type Step } from './automation';
import { evaluateStep, type Decision, type PolicyContext } from './policy';
import type { AutonomyLevel } from './types';

/**
 * Thrown by an executor to say why it refused a focus or key step, in words that are safe to show. The runner keeps
 * this message on the step record as failureReason, and the step and run are blocked rather than failed, because nothing
 * was done. Any other thrown error is an ordinary failure, and its text is not kept.
 */
export class StepRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StepRefusedError';
  }
}

/**
 * The only side-effecting surface the runner touches. Tests supply a fake; the desktop app supplies the OS.
 * The three optional methods are steps an adapter may not support. A missing method blocks that step before anyone
 * is asked. A block is not a failure, so it does not demote the automation.
 */
export interface Executor {
  /** Brings the named application forward. It may throw a StepRefusedError to say why it refused. */
  focusApp(app: string): Promise<boolean>;
  frontmostApp(): Promise<string | undefined>;
  /** Opens an allowed http or https address, in canonical form, in the named browser. */
  openUrl?(app: string, url: string): Promise<boolean>;
  /** Opens one checked file in the named application. */
  openFile?(app: string, path: string): Promise<boolean>;
  /**
   * Presses a checked key chord in the named application. The adapter must bring that application forward and send the
   * keys only once it is in front, and return false otherwise. The runner cannot check this itself: the approval dialog
   * takes focus, so a check made before approval would be wrong by the time the keys are sent. It may throw a
   * StepRefusedError to say why it refused.
   */
  pressShortcut?(app: string, shortcut: string): Promise<boolean>;
  /**
   * Chooses one menu path in the named application: the menu bar item, each submenu, then the item. The adapter returns true
   * only when each click that opens a menu was confirmed, the last click was delivered, and the menu closed afterwards, so
   * true is the step's postcondition. The last click cannot be confirmed from the menu, since the menu closes as the item
   * runs. It may throw a StepRefusedError to say why it refused, when nothing was chosen.
   */
  chooseMenu?(app: string, menu: readonly string[]): Promise<boolean>;
  /**
   * Why this executor cannot carry out a focus or key step right now, or undefined when it can. The runner asks only for
   * those two steps, before anyone is asked, and a reason blocks the step. The desktop app uses it when its optional
   * agent-desktop program is set but unusable.
   */
  blockedReason?(op: DesktopOp | 'focus_app' | 'press_shortcut' | 'choose_menu'): string | undefined;
  /**
   * The desktop steps, each in one window of the app (the first whose title starts with `window`, or the app's only
   * window). Each returns true only when the program confirmed the action: a click delivered, text pasted, a key sent,
   * a field showing exactly the entered text before it is submitted, a field typed into. Each may throw a
   * StepRefusedError when nothing was done, such as when the element or window was not found.
   */
  click?(app: string, window: string | undefined, target: Locator, button: 'left' | 'right', count?: 1 | 2): Promise<boolean>;
  /** Pastes text; with `via`, first enters where to paste in a field, checked, all in one turn of the input. */
  pasteText?(app: string, window: string | undefined, text: string, via?: { target: Locator; text: string }): Promise<boolean>;
  pressKey?(app: string, window: string | undefined, key: string): Promise<boolean>;
  fillField?(app: string, window: string | undefined, target: Locator, text: string, submit: boolean): Promise<boolean>;
  setField?(app: string, window: string | undefined, target: Locator, text: string): Promise<boolean>;
  /**
   * Moves every copy of a duplicate file but the oldest from the folders into the review folder, writes a manifest there,
   * and returns how many copies moved. True to its postcondition: each moved file is in the review folder and gone from
   * where it was. Paths are "~/..." inside the home folder.
   */
  gatherDuplicates?(folders: readonly string[], into: string): Promise<{ moved: number; bytes: number }>;
  /** The text a check reads: the clipboard, or every piece of text shown in the window. Never kept by the runner. */
  readText?(app: string, window: string | undefined, source: 'clipboard' | 'window'): Promise<string>;
  /**
   * Runs one step's action and its postcondition with sole use of the desktop's input, so two runs never interleave focus
   * changes, key presses and menu clicks, and one run cannot move focus between another's action and its check. The
   * runner enters it after the step's approval, never while a person is being asked. Absent means no lock.
   */
  exclusive?<T>(work: () => Promise<T>): Promise<T>;
}

/** The steps that act in one window through the agent-desktop program. */
export type DesktopOp = 'click' | 'paste_text' | 'press_key' | 'fill_field' | 'set_field' | 'check_text';
const DESKTOP_OPS: readonly Step['op'][] = ['click', 'paste_text', 'press_key', 'fill_field', 'set_field', 'check_text'];

/**
 * A person's answer to one step's approval: no, yes for this step, or yes for every step of this run. The last still
 * runs each step through the policy, so a denied step stops the run; it only spares the person a question per step.
 */
export type Approval = boolean | 'run';

export type RunMode = 'dry_run' | 'supervised' | 'unattended';

export type StepOutcome = 'dry_run' | 'executed' | 'passed' | 'check_failed' | 'blocked' | 'failed';

export interface StepRecord {
  index: number;
  op: Step['op'];
  app: string;
  outcome: StepOutcome;
  reason: string;
  /** Why the executor refused the step, when it said so with a StepRefusedError. Absent for every other failure. */
  failureReason?: string;
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
  /** Called as each step begins, before it is checked or asked about, so a live view can say what the run is doing. */
  onStep?: (index: number, total: number, step: Step) => void;
  /** Called only for steps the policy marks 'ask', and only in supervised mode. 'run' approves the rest of this run. */
  approve?: (step: Step, decision: Decision) => Promise<Approval>;
  /**
   * How long the postcondition of an open or key step waits for the OS to bring the expected app forward. Focus
   * can take a moment to move. Defaults to 1.5 seconds. Tests set it to 0.
   */
  settleMs?: number;
}

const DEFAULT_SETTLE_MS = 1_500;
/** How often a check that waits for text reads again. */
const CHECK_POLL_MS = 500;
const SETTLE_POLL_MS = 150;

const FAILED_REASON = {
  open_url: 'The address could not be opened.',
  open_file: 'The file could not be opened.',
  press_shortcut: 'The shortcut could not be pressed.',
  choose_menu: 'The menu item could not be chosen.',
  click: 'The element could not be clicked.',
  paste_text: 'The text could not be pasted.',
  press_key: 'The key could not be pressed.',
  fill_field: 'The field could not be filled.',
  set_field: 'The field could not be typed into.',
} as const;

const DONE_REASON = {
  click: 'Done. The click was delivered.',
  paste_text: 'Done. The text was pasted.',
  press_key: 'Done. The key was pressed.',
  fill_field: 'Done. The field showed the text before it was submitted.',
  set_field: 'Done. The text was typed into the field.',
} as const;

const MISSING_REASON = {
  click: 'This system cannot click elements yet. Set the agent-desktop program in Settings.',
  paste_text: 'This system cannot paste text yet. Set the agent-desktop program in Settings.',
  press_key: 'This system cannot press keys yet. Set the agent-desktop program in Settings.',
  fill_field: 'This system cannot fill fields yet. Set the agent-desktop program in Settings.',
  set_field: 'This system cannot type into fields yet. Set the agent-desktop program in Settings.',
  check_text: 'This system cannot read text yet. Set the agent-desktop program in Settings.',
} as const;

const EXECUTOR_METHOD = {
  click: 'click',
  paste_text: 'pasteText',
  press_key: 'pressKey',
  fill_field: 'fillField',
  set_field: 'setField',
  check_text: 'readText',
} as const;

/** The values that must not be shown but are, ignoring case and runs of spaces and line breaks. */
export function presentText(text: string, absent: readonly string[]): string[] {
  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim().toLowerCase();
  const haystack = flat(text);
  return absent.filter(value => haystack.includes(flat(value)));
}

/** The expected values a check could not find in the text it read. Matching ignores runs of spaces and line breaks. */
export function missingText(text: string, expect: readonly string[]): string[] {
  const flat = (value: string): string => value.replace(/\s+/g, ' ').trim();
  const haystack = flat(text);
  return expect.filter(value => !haystack.includes(flat(value)));
}

function sameApp(observed: string | undefined, expected: string): boolean {
  return observed !== undefined && normalizeAppName(observed) === normalizeAppName(expected);
}

/** Why this system cannot carry out a step at all, or undefined when it can. */
function unsupportedReason(step: Step, executor: Executor): string | undefined {
  if (step.op === 'focus_app' || step.op === 'press_shortcut' || step.op === 'choose_menu' || DESKTOP_OPS.includes(step.op)) {
    const blocked = executor.blockedReason?.(step.op as DesktopOp | 'focus_app' | 'press_shortcut' | 'choose_menu');
    if (blocked) return blocked;
  }
  if (DESKTOP_OPS.includes(step.op)) {
    const op = step.op as DesktopOp;
    if (!executor[EXECUTOR_METHOD[op]]) return MISSING_REASON[op];
  }
  if (step.op === 'gather_duplicates' && !executor.gatherDuplicates) return 'This system cannot gather duplicate files yet.';
  if (step.op === 'open_url' && !executor.openUrl) return 'This system cannot open web addresses yet.';
  if (step.op === 'open_file' && !executor.openFile) return 'This system cannot open files yet.';
  if (step.op === 'press_shortcut' && !executor.pressShortcut) return 'This system cannot press shortcuts yet.';
  if (step.op === 'choose_menu' && !executor.chooseMenu) {
    return 'This system cannot choose menu items yet. Outside macOS, set the agent-desktop program in Settings.';
  }
  return undefined;
}

/** The message of a refusal the executor chose to show, or undefined for any other thrown error. */
function refusalMessage(error: unknown): string | undefined {
  return error instanceof StepRefusedError ? error.message : undefined;
}

/** The outcome of one open or key step, and the refusal text when the executor gave one. */
interface Performed {
  ok: boolean;
  failureReason?: string;
}

/** Carries out one open or key step. A thrown error is an ordinary failure, as with focusApp. */
async function perform(step: Step, executor: Executor): Promise<Performed> {
  try {
    switch (step.op) {
      case 'open_url': {
        const url = parseWebAddress(step.url);
        return { ok: url !== undefined && (await executor.openUrl?.(step.app, url.href)) === true };
      }
      case 'open_file':
        return { ok: (await executor.openFile?.(step.app, step.path)) === true };
      case 'press_shortcut':
        return { ok: (await executor.pressShortcut?.(step.app, step.shortcut)) === true };
      case 'choose_menu':
        return { ok: (await executor.chooseMenu?.(step.app, step.menu)) === true };
      case 'click':
        return { ok: (await executor.click?.(step.app, step.window, step.target, step.button ?? 'left', step.count ?? 1)) === true };
      case 'paste_text':
        return { ok: (await executor.pasteText?.(step.app, step.window, step.text, step.via)) === true };
      case 'press_key':
        return { ok: (await executor.pressKey?.(step.app, step.window, step.key)) === true };
      case 'fill_field':
        return { ok: (await executor.fillField?.(step.app, step.window, step.target, step.text, step.submit)) === true };
      case 'set_field':
        return { ok: (await executor.setField?.(step.app, step.window, step.target, step.text)) === true };
      default:
        return { ok: false };
    }
  } catch (error) {
    return { ok: false, failureReason: refusalMessage(error) };
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
  const livePolicy = (): PolicyContext =>
    request.currentPolicy?.() ?? {
      ...request.policy,
      level: request.currentLevel ? request.currentLevel() : request.policy.level,
    };

  const recordAt = (index: number, step: Step, outcome: StepOutcome, reason: string, failureReason?: string): void => {
    steps.push({
      index,
      op: step.op,
      app: step.app,
      outcome,
      reason,
      ...(failureReason === undefined ? {} : { failureReason }),
    });
  };

  /** The check that the expected app is in front, recorded under the check step's own index. */
  const checkInFront = async (index: number, step: Step): Promise<RunResult['status'] | undefined> => {
    let front: string | undefined;
    try {
      front = await executor.frontmostApp();
    } catch {
      front = undefined;
    }
    if (sameApp(front, step.app)) {
      passed++;
      recordAt(index, step, 'passed', 'Expected app is in front.');
      return undefined;
    }
    failed++;
    recordAt(index, step, 'check_failed', 'A different app is in front.');
    return 'failed';
  };

  /** Set when a focus step ran the check that follows it in the same turn, so the loop does not run that check again. */
  let checkedWithFocus = -1;
  /** Set when the person approved every step of this run. Each step is still checked against the policy. */
  let approvedForRun = false;

  for (const [index, step] of resolved.entries()) {
    if (index === checkedWithFocus) continue;
    const record = (outcome: StepOutcome, reason: string, failureReason?: string): void =>
      recordAt(index, step, outcome, reason, failureReason);

    try {
      request.onStep?.(index, resolved.length, step);
    } catch {
      // A live view must not stop a run.
    }

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

    let approved = approvedForRun;
    let decision: Decision;
    for (;;) {
      if (request.shouldStop?.()) {
        record('blocked', 'Automations were stopped.');
        return finish('blocked');
      }

      decision = evaluateStep(step, { ...livePolicy(), unattended: request.mode === 'unattended' });
      if (decision.decision === 'deny') {
        record('blocked', decision.reason);
        return finish('blocked');
      }
      if (decision.decision !== 'ask' || approved) break;

      const answer = request.approve ? await request.approve(step, decision) : false;
      // A yes for the run counts only while a person is there to give it: never for an unattended run.
      if (answer === 'run' && request.mode === 'supervised') approvedForRun = true;
      approved = answer !== false;
      if (!approved) {
        record('blocked', 'Not approved.');
        return finish('blocked');
      }
      // Settings may have changed while the native approval dialog was open. Loop and re-check them.
    }

    // The step's action and its postcondition hold the desktop's input, so another run cannot move focus or open a menu
    // between them. The approval above was asked outside the lock, so a person is never waited on while holding it.
    const act = async (): Promise<RunResult['status'] | undefined> => {
      // The lock may have been held by another run for a while. A stop pressed meanwhile, or a policy change, still wins.
      if (request.shouldStop?.()) {
        record('blocked', 'Automations were stopped.');
        return 'blocked';
      }
      const recheck = evaluateStep(step, { ...livePolicy(), unattended: request.mode === 'unattended' });
      if (recheck.decision === 'deny' || (recheck.decision === 'ask' && !approved)) {
        record('blocked', recheck.decision === 'deny' ? recheck.reason : 'Not approved.');
        return 'blocked';
      }
      return performStep();
    };

    const performStep = async (): Promise<RunResult['status'] | undefined> => {
      if (step.op === 'focus_app') {
        let ok = false;
        let failureReason: string | undefined;
        try {
          ok = await executor.focusApp(step.app);
        } catch (error) {
          // A thrown error is an ordinary failure. Its text may contain paths or scripts, so only a StepRefusedError keeps it.
          failureReason = refusalMessage(error);
        }
        if (!ok) {
          // A refusal means nothing was done, so the run is blocked and not failed. Only a failed run lowers the level.
          if (failureReason !== undefined) {
            record('blocked', 'The app could not be focused.', failureReason);
            return 'blocked';
          }
          record('failed', 'The app could not be focused.');
          return 'failed';
        }
        record('executed', decision.reason);
        // The check that follows a focus runs in the same turn, so another run cannot move focus between the two. It is
        // folded in only when the policy allows it outright now; otherwise it takes its own turn as any other step.
        const next = resolved[index + 1];
        if (
          next?.op === 'check_focus' &&
          sameApp(next.app, step.app) &&
          !request.shouldStop?.() &&
          evaluateStep(next, { ...livePolicy(), unattended: request.mode === 'unattended' }).decision === 'allow' &&
          unsupportedReason(next, executor) === undefined
        ) {
          checkedWithFocus = index + 1;
          return checkInFront(index + 1, next);
        }
        return undefined;
      }

      if (step.op === 'choose_menu') {
        // The approval dialog takes focus, so the app is brought forward again first, as a person would before choosing.
        // Nothing has been chosen if that fails, so the run is blocked rather than failed.
        let front = false;
        let focusRefusal: string | undefined;
        try {
          front = await executor.focusApp(step.app);
        } catch (error) {
          focusRefusal = refusalMessage(error);
        }
        if (!front) {
          record('blocked', 'The app could not be brought forward to choose the menu.', focusRefusal);
          return 'blocked';
        }
        // A headless menu click does not need the app in front, so the postcondition is the adapter's own: the menu opened,
        // the item's click was delivered, and the menu closed. A refusal blocks the run, and any other failure fails it, as
        // for the open and key steps.
        const performed = await perform(step, executor);
        if (performed.ok) {
          passed++;
          record('passed', 'Done. The menu item was chosen and the menu closed.');
          return undefined;
        }
        if (performed.failureReason !== undefined) {
          record('blocked', FAILED_REASON[step.op], performed.failureReason);
          return 'blocked';
        }
        record('failed', FAILED_REASON[step.op]);
        return 'failed';
      }

      if (step.op === 'check_text') {
        // Reads the clipboard or the window's text, and passes only when every expected value is there. A window is read
        // again for up to withinMs while values are missing, since a page may still be loading. The text read is compared
        // and dropped; only how many values were missing is kept.
        const deadline = Date.now() + (step.withinMs ?? 0);
        let missing: string[] = step.expect;
        let unwanted: string[] = [];
        for (;;) {
          let text: string | undefined;
          try {
            text = await executor.readText?.(step.app, step.window, step.source);
          } catch (error) {
            const refusal = refusalMessage(error);
            if (refusal !== undefined) {
              record('blocked', 'The text could not be read.', refusal);
              return 'blocked';
            }
          }
          if (text === undefined) {
            record('failed', 'The text could not be read.');
            return 'failed';
          }
          missing = missingText(text, step.expect);
          unwanted = presentText(text, step.absent ?? []);
          if ((missing.length === 0 && unwanted.length === 0) || Date.now() >= deadline || request.shouldStop?.()) break;
          await new Promise(resolve => setTimeout(resolve, CHECK_POLL_MS));
        }
        if (missing.length === 0 && unwanted.length === 0) {
          passed++;
          record('passed', `Shown: all ${step.expect.length} expected value${step.expect.length === 1 ? '' : 's'}.`);
          return undefined;
        }
        failed++;
        const reasons = [
          ...(missing.length > 0 ? [`${missing.length} of ${step.expect.length} expected values were not shown.`] : []),
          ...(unwanted.length > 0 ? [`${unwanted.length} value${unwanted.length === 1 ? '' : 's'} that should be gone ${unwanted.length === 1 ? 'was' : 'were'} still shown.`] : []),
        ];
        record('check_failed', reasons.join(' '));
        return 'failed';
      }

      if (step.op === 'gather_duplicates') {
        try {
          const gathered = await executor.gatherDuplicates?.(step.folders, step.into);
          if (gathered) {
            passed++;
            const mb = (gathered.bytes / 1_000_000).toFixed(1);
            record('passed', `Done. ${gathered.moved} duplicate cop${gathered.moved === 1 ? 'y' : 'ies'} (${mb} MB) moved into ${step.into}, with a manifest to undo it.`);
            return undefined;
          }
        } catch (error) {
          const refusal = refusalMessage(error);
          if (refusal !== undefined) {
            record('blocked', 'The duplicate files could not be gathered.', refusal);
            return 'blocked';
          }
        }
        record('failed', 'The duplicate files could not be gathered.');
        return 'failed';
      }

      if (step.op === 'click' || step.op === 'paste_text' || step.op === 'press_key' || step.op === 'fill_field' || step.op === 'set_field') {
        // The adapter acts in the named window and confirms the action itself, so true is the postcondition. A refusal
        // means nothing was done, so the run is blocked; any other failure fails it.
        const performed = await perform(step, executor);
        if (performed.ok) {
          passed++;
          record('passed', DONE_REASON[step.op]);
          return undefined;
        }
        if (performed.failureReason !== undefined) {
          record('blocked', FAILED_REASON[step.op], performed.failureReason);
          return 'blocked';
        }
        record('failed', FAILED_REASON[step.op]);
        return 'failed';
      }

      if (step.op === 'open_url' || step.op === 'open_file' || step.op === 'press_shortcut') {
        // One action, then its postcondition: the expected app is in front once the action has run.
        const performed = await perform(step, executor);
        if (!performed.ok) {
          if (performed.failureReason !== undefined) {
            record('blocked', FAILED_REASON[step.op], performed.failureReason);
            return 'blocked';
          }
          record('failed', FAILED_REASON[step.op]);
          return 'failed';
        }
        if (await settlesInFront(executor, step.app, request.settleMs ?? DEFAULT_SETTLE_MS)) {
          passed++;
          record('passed', 'Done. The expected app is in front.');
          return undefined;
        }
        failed++;
        record('check_failed', 'A different app is in front.');
        return 'failed';
      }

      return checkInFront(index, step);
    };

    // A pause touches nothing, so it waits outside the input lock and other runs keep their turns meanwhile.
    if (step.op === 'wait') {
      await new Promise(resolve => setTimeout(resolve, step.ms));
      record('executed', `Waited ${step.ms} ms.`);
      continue;
    }

    const outcome = executor.exclusive ? await executor.exclusive(act) : await act();
    if (outcome !== undefined) return finish(outcome);
  }
  return finish(request.mode === 'dry_run' ? 'dry_run' : 'completed');
}
