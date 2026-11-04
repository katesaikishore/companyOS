import { z } from 'zod';
import type { OperatorModel } from './loop';

/**
 * Plans a task the person typed in the bar, before the operator starts: which app to start in, and a few steps in plain
 * words. The operator still chooses every action from what the screen shows; the plan is a guide it reads each turn, so a
 * small model does not have to work out the whole task from the first screen.
 */

export interface TaskPlan {
  /** The app to start in, as macOS names it. */
  app: string;
  steps: string[];
}

const APP = /^[\p{L}\p{N}][\p{L}\p{N} .\-()]{0,79}$/u;
const MAX_STEPS = 8;
const STEP_CHARS = 160;
const SHOWN_APPS = 40;

const PLAN_SYSTEM = [
  'You plan a task the person typed, for an operator that works in their Mac apps through the apps’ accessibility controls:',
  'it clicks, types, presses keys and opens apps, one step at a time.',
  'Choose the app to start in, named as macOS names it, such as "Google Chrome", "Finder", "Notes" or "Slack".',
  'Prefer an app that is running when one fits. For a website, start in the browser that is running.',
  'Then write up to 8 short steps in plain words, each one thing the operator does, such as "Open slides.new in a new tab".',
  'Do not plan to send, post, pay or delete unless the task asks for it.',
  'Reply only with JSON: {"app": "...", "steps": ["..."]}.',
].join(' ');

const PlanReply = z.object({
  app: z.string().trim().min(1).max(80),
  steps: z.array(z.string().trim().min(1)).max(20),
});

/**
 * The plan for a goal, or undefined when the model gives none in the right shape. The running apps and the app in front
 * are names only. An app name that is not a plain name is refused, and the person's front app is used instead.
 */
export async function planTask(goal: string, apps: { running: readonly string[]; front?: string }, model: OperatorModel, signal?: AbortSignal): Promise<TaskPlan | undefined> {
  const running = apps.running.filter(name => APP.test(name)).slice(0, SHOWN_APPS);
  const reply = await model.complete({
    system: PLAN_SYSTEM,
    prompt: [
      `Task: ${goal}`,
      apps.front && APP.test(apps.front) ? `App in front: ${apps.front}` : '',
      running.length > 0 ? `Running apps: ${running.join(', ')}` : '',
      '/no_think',
    ]
      .filter(Boolean)
      .join('\n'),
    schema: {
      type: 'object',
      properties: { app: { type: 'string' }, steps: { type: 'array', items: { type: 'string' } } },
      required: ['app', 'steps'],
    },
    maxTokens: 400,
    ...(signal ? { signal } : {}),
  });
  const parsed = PlanReply.safeParse(reply);
  if (!parsed.success) return undefined;
  const app = APP.test(parsed.data.app) ? parsed.data.app : apps.front;
  if (!app || !APP.test(app)) return undefined;
  return { app, steps: parsed.data.steps.slice(0, MAX_STEPS).map(step => step.slice(0, STEP_CHARS)) };
}
