import type { Automation, Step } from './automation';
import { normalizeAppName } from './classify';
import type { AssignedTaskView } from './contract';
import { dayKeyOf } from './tasks';
import type { RunRecord } from './autonomy';
import type { AutonomyLevel } from './types';

/** How far back Recall observations count toward a task's priority. A design value. */
export const RECALL_TASK_WINDOW_DAYS = 7;
/** How many local days the task-run graph shows, the latest last. A design value. */
export const TASK_RUN_DAYS = 14;

const DAY_MS = 86_400_000;
/** An observation this recent counts in full. Older ones, still inside the window, count half. A design value. */
const RECENT_MS = DAY_MS;

/** One app's stored Recall observations: how many, and when the newest was. Holds no text. */
export interface RecallEvidence {
  app: string;
  count: number;
  latest: number;
}

/** An automation as the ranking needs it: the routine, its level, and its estimated time back. */
export interface RankableAutomation {
  automation: Automation;
  level: AutonomyLevel;
}

/**
 * The apps a routine works in: every app a step names, with a `$pN` parameter standing for its approved options. The
 * names are normalised the way the store normalises the apps it records, so they match the evidence.
 */
export function routineApps(automation: Automation): string[] {
  const apps = new Set<string>();
  for (const step of automation.steps) {
    for (const app of stepAppNames(step, automation)) apps.add(normalizeAppName(app));
  }
  return [...apps];
}

function stepAppNames(step: Step, automation: Automation): string[] {
  const reference = /^\$(p\d+)$/.exec(step.app);
  if (!reference) return [step.app];
  const param = automation.params.find(candidate => candidate.name === reference[1]);
  return param?.options ?? [];
}

/**
 * Ranks the automations by what Recall saw of their apps in the window. An automation with no observation is not
 * assigned. The score is the observations of its apps, each counted in full when recent and half when older, times the
 * estimated minutes a week it saves, so a routine that is seen often and saves time runs first. Ties go to the name.
 */
export function assignRecallTasks(
  automations: readonly RankableAutomation[],
  evidence: readonly RecallEvidence[],
  now: number,
): AssignedTaskView[] {
  const windowStart = now - RECALL_TASK_WINDOW_DAYS * DAY_MS;
  const inWindow = evidence.filter(item => item.latest >= windowStart);
  const tasks: AssignedTaskView[] = [];
  for (const { automation, level } of automations) {
    const apps = new Set(routineApps(automation));
    const matched = inWindow.filter(item => apps.has(item.app));
    if (matched.length === 0) continue;
    const observations = matched.reduce((sum, item) => sum + item.count, 0);
    const weighted = matched.reduce((sum, item) => sum + item.count * (now - item.latest <= RECENT_MS ? 1 : 0.5), 0);
    const minutes = Math.max(1, automation.estimate?.minutesPerWeek ?? 1);
    tasks.push({
      automationId: automation.id,
      name: automation.name,
      observations,
      latest: Math.max(...matched.map(item => item.latest)),
      priority: Math.round(weighted * minutes * 100) / 100,
      level,
    });
  }
  return tasks.sort((a, b) => b.priority - a.priority || a.name.localeCompare(b.name));
}

/**
 * How many runs each local day had over the last TASK_RUN_DAYS days, oldest first and today last. Only completed and
 * failed runs are kept, so a blocked run does not appear. Days are counted by the local calendar, not by 24-hour steps.
 */
export function taskRunsByDay(automations: readonly { state: { runs: readonly RunRecord[] } }[], now: number): number[] {
  const today = new Date(now);
  const days = Array.from({ length: TASK_RUN_DAYS }, (_, index) =>
    dayKeyOf(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (TASK_RUN_DAYS - 1 - index)).getTime()),
  );
  const counts = new Map<string, number>(days.map(day => [day, 0]));
  for (const view of automations) {
    for (const run of view.state.runs) {
      const day = dayKeyOf(run.ts);
      if (counts.has(day)) counts.set(day, (counts.get(day) ?? 0) + 1);
    }
  }
  return days.map(day => counts.get(day) ?? 0);
}
