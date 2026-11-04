import type { OperatorTaskView } from '@companyos/twin-core';

/**
 * What the menu bar shows for the task operator, so the person can see from any app that a task is working. From the
 * moment a task is given, while the bar plans it and while its steps run, a dot beside the icon pulses between filled and
 * hollow; when a step waits for the person, the dot stays filled; when no task runs, nothing shows. The tooltip names the
 * task and how far it has got.
 */
export interface TaskIndicator {
  /** Text beside the menu bar icon. macOS shows it; other systems have no title and use the tooltip only. */
  title: string;
  tooltip: string;
}

/** How often the dot changes while a task runs. */
export const PULSE_MS = 700;
const IDLE_TOOLTIP = 'companyOS Twin';
const SHOWN_GOAL = 60;

/** A task as the menu bar sees it. planning is the bar's planner at work, before the operator has the task. */
export interface IndicatedTask {
  state: OperatorTaskView['state'] | 'planning';
  goal?: string;
  steps: readonly unknown[];
}

export function taskIndicator(task: IndicatedTask, tick: number): TaskIndicator {
  if (task.state === 'idle') return { title: '', tooltip: IDLE_TOOLTIP };
  const goal = (task.goal ?? '').replace(/\s+/g, ' ').trim();
  const shown = goal.length > SHOWN_GOAL ? `${goal.slice(0, SHOWN_GOAL - 1)}…` : goal;
  const steps = task.steps.length === 1 ? '1 step' : `${task.steps.length} steps`;
  const pulse = tick % 2 === 0 ? '●' : '○';
  if (task.state === 'planning') return { title: pulse, tooltip: `companyOS Twin is planning: ${shown}` };
  if (task.state === 'waiting') return { title: '●', tooltip: `companyOS Twin is waiting for you: ${shown}` };
  return { title: pulse, tooltip: `companyOS Twin is working on: ${shown} (${steps} so far)` };
}
