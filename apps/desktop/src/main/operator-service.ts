import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import {
  runTask,
  type OperatorAction,
  type OperatorHands,
  type OperatorModel,
  type OperatorStep,
  type OperatorStepView,
  type OperatorTaskRequest,
  type OperatorTaskView,
} from '@companyos/twin-core';
import { APP_NAME } from './app-surface';

/**
 * Runs one task at a time for the Tasks page. It keeps the steps to show, holds the step that waits for the person until
 * they answer, and stops the task on request. The checks on each step live in the operator itself; this class only carries
 * the person's answers to it.
 */

export type OperatorModelChoice = 'local' | 'chutes';

interface OperatorServiceDeps {
  config: () => { excludedApps: readonly string[]; agentDesktopPath: string; operatorModel: OperatorModelChoice };
  hands: (binary: string) => OperatorHands;
  /** The chosen model, or undefined when it cannot be used, such as Chutes with no saved key. */
  model: (choice: OperatorModelChoice, options: { sharesScreenText: boolean }) => Promise<OperatorModel | undefined>;
  /** Short notes from captured screen text that bear on the goal. */
  memory: (goal: string) => string[];
  hasChutesKey: () => boolean;
  /** The twin's own app names. The operator never reads or acts in its own window. */
  ownApps: readonly string[];
  onChange: () => void;
}

const MAX_GOAL = 500;
const MAX_STEPS = 20;
const SHOWN_TEXT = 80;

interface Running {
  goal: string;
  app: string;
  model: OperatorModelChoice;
  controller: AbortController;
}

interface Waiting {
  id: string;
  text: string;
  why: string;
  detail?: string;
  resolve: (approve: boolean) => void;
}

function short(text: string): string {
  return text.length > SHOWN_TEXT ? `${text.slice(0, SHOWN_TEXT - 1)}…` : text;
}

/** An action in plain words, with the control's name when the operator knows it. */
export function describeAction(action: OperatorAction, target?: string): string {
  const named = target ? `"${short(target)}"` : 'a control';
  switch (action.type) {
    case 'click':
      return `Click ${named}`;
    case 'type':
      return `Type "${short(action.text)}" into ${target ? named : 'a text field'}`;
    case 'press':
      return `Press ${action.keys}`;
    case 'scroll':
      return `Scroll ${action.direction} in ${named}`;
    case 'launch':
      return `Open ${action.app}`;
    case 'focus_app':
      return `Switch to ${action.app}`;
    case 'done':
      return `Finished: ${short(action.summary)}`;
    case 'fail':
      return `Could not finish: ${short(action.reason)}`;
  }
}

function stepView(step: OperatorStep): OperatorStepView {
  if (step.noAnswer) return { n: step.n, text: 'The model did not answer', outcome: 'no_answer', why: step.error };
  const text = step.action ? describeAction(step.action, step.target) : 'The model gave a step that could not run';
  if (!step.action) return { n: step.n, text, outcome: 'invalid', why: step.error };
  if (step.action.type === 'done' || step.action.type === 'fail') return { n: step.n, text, outcome: 'finished' };
  if (step.verdict === 'deny') return { n: step.n, text, outcome: 'refused', why: step.why };
  if (step.verdict === 'ask' && step.approved === false) return { n: step.n, text, outcome: 'held', why: step.why };
  const outcome =
    step.delivery === 'delivered' ? 'landed' :
    step.delivery === 'unverified' ? 'unverified' :
    step.delivery === 'not_delivered' ? 'not_landed' : 'may_have_landed';
  return { n: step.n, text, outcome, why: step.why };
}

export class OperatorService {
  private running: Running | undefined;
  private waiting: Waiting | undefined;
  private steps: OperatorStepView[] = [];
  private result: OperatorTaskView['result'];
  private last: { goal: string; app: string } | undefined;

  constructor(private readonly deps: OperatorServiceDeps) {}

  view(): OperatorTaskView {
    const config = this.deps.config();
    return {
      state: this.waiting ? 'waiting' : this.running ? 'running' : 'idle',
      goal: this.running?.goal ?? this.last?.goal,
      app: this.running?.app ?? this.last?.app,
      model: this.running?.model ?? config.operatorModel,
      steps: [...this.steps],
      pending: this.waiting ? { id: this.waiting.id, text: this.waiting.text, why: this.waiting.why, detail: this.waiting.detail } : undefined,
      result: this.running ? undefined : this.result,
      ready: { agentDesktop: isAbsolute(config.agentDesktopPath.trim()), chutesKey: this.deps.hasChutesKey() },
    };
  }

  /**
   * Starts a task, or throws a sentence the page can show. The task counts as running from the first check, so Stop works
   * while the key is read from the keychain, and every way out of start clears it.
   */
  async start(request: OperatorTaskRequest): Promise<void> {
    if (this.running) throw new Error('A task is already running. Stop it first.');
    const goal = typeof request.goal === 'string' ? request.goal.trim() : '';
    const app = typeof request.app === 'string' ? request.app.trim() : '';
    if (goal.length === 0 || goal.length > MAX_GOAL) throw new Error(`Describe the task in 1 to ${MAX_GOAL} characters.`);
    if (!APP_NAME.test(app)) throw new Error('Give the name of the app to start in.');
    const config = this.deps.config();
    const binary = config.agentDesktopPath.trim();
    if (!isAbsolute(binary)) throw new Error('Set the full agent-desktop program path in Settings first, such as /opt/homebrew/bin/agent-desktop.');

    // The choice is taken once. A switch during the task does not change where this task's steps go.
    const choice = config.operatorModel;
    const shares = choice === 'local' || request.shareMemory === true;
    const controller = new AbortController();
    this.running = { goal, app, model: choice, controller };
    this.steps = [];
    this.result = undefined;
    this.deps.onChange();

    let model: OperatorModel | undefined;
    let hands: OperatorHands;
    try {
      model = await this.deps.model(choice, { sharesScreenText: choice === 'chutes' && shares });
      hands = this.deps.hands(binary);
    } catch (error) {
      this.finish(goal, app, undefined);
      throw error instanceof Error ? error : new Error('The task could not start.');
    }
    if (controller.signal.aborted) {
      this.finish(goal, app, { status: 'stopped' });
      return;
    }
    if (!model) {
      this.finish(goal, app, undefined);
      throw new Error('Save a Chutes key first, or switch the model to this Mac.');
    }
    // Memory notes come from captured screen text. They go to a model on this Mac, and to Chutes only when the person ticks the box.
    const context = shares ? this.deps.memory(goal) : [];

    void runTask({ goal, app, context }, model, hands, {
      excludedApps: [...config.excludedApps, ...this.deps.ownApps],
      excludedAppsNow: () => [...this.deps.config().excludedApps, ...this.deps.ownApps],
      includeValues: shares,
      maxSteps: MAX_STEPS,
      signal: controller.signal,
      approve: (action, why, signal, target) => this.ask(action, describeAction(action, target), why, signal),
      onStep: step => {
        this.steps.push(stepView(step));
        this.deps.onChange();
      },
    })
      .then(result => this.finish(goal, app, { status: result.status, summary: result.summary }))
      .catch(() => this.finish(goal, app, { status: 'failed', summary: 'The task stopped with an error.' }));
  }

  /** Stops the running task. A step that waits for the person is declined. */
  stop(): void {
    this.running?.controller.abort();
    const waiting = this.waiting;
    this.waiting = undefined;
    waiting?.resolve(false);
    this.deps.onChange();
  }

  /** Carries the person's answer to the step that waits. */
  answer(id: string, approve: boolean): void {
    const waiting = this.waiting;
    if (!waiting || waiting.id !== id) throw new Error('That step is no longer waiting.');
    this.waiting = undefined;
    waiting.resolve(approve === true);
    this.deps.onChange();
  }

  private finish(goal: string, app: string, result: OperatorTaskView['result']): void {
    this.last = { goal, app };
    this.running = undefined;
    this.waiting = undefined;
    this.result = result;
    this.deps.onChange();
  }

  /** Holds a step for the person. Typed text is shown in full, so the person approves exactly what will be typed. */
  private ask(action: OperatorAction, text: string, why: string, signal?: AbortSignal): Promise<boolean> {
    return new Promise(resolve => {
      const id = randomUUID();
      this.waiting = { id, text, why, detail: action.type === 'type' ? action.text : undefined, resolve };
      signal?.addEventListener(
        'abort',
        () => {
          if (this.waiting?.id !== id) return;
          this.waiting = undefined;
          resolve(false);
        },
        { once: true },
      );
      this.deps.onChange();
    });
  }
}
