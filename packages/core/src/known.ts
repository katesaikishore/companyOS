import { defaultName, fitName, type Automation } from './automation';
import type { DeclinedRoutineView, KnownRoutinesView, RoutineStepView, RoutineView } from './contract';
import { describeWhen, type Routine, type RoutineStep } from './mine';
import type { DeclineRecord } from './triggers';
import type { AutonomyLevel } from './types';

/** An accepted routine: the automation it became, and the level that automation is at. */
export interface AcceptedRoutine {
  automation: Automation;
  level: AutonomyLevel;
}

export interface KnownRoutinesInput {
  /** Routines detected in the analysis window. Dismissed ones are included, so a declined routine can still be named. */
  routines: readonly Routine[];
  /** Automations accepted from a routine. */
  accepted: readonly AcceptedRoutine[];
  /** True for a routine the person dismissed, by its id or as a near copy of a dismissed routine. */
  isDismissed: (routine: Routine) => boolean;
  /** The name the local model gave a detected routine, when it has one. */
  modelName: (routineId: string) => string | undefined;
  /** The ids of dismissed routines. A dismissal kept by an earlier version has an id here and no decline record. */
  dismissedIds: readonly string[];
  /** The declines kept for each routine: when the latest was, and how many came in a row. */
  declines: readonly DeclineRecord[];
}

/**
 * What the twin knows about the person's routines. A dismissed routine leaves the list and is shown with the declines,
 * where a reset can bring it back. An accepted routine stays listed, dismissed or not, because its automation still
 * exists. A routine that is no longer detected is shown from its automation, with no time of day and no site.
 */
export function knownRoutinesView(input: KnownRoutinesInput): KnownRoutinesView {
  const names = routineNames(input);
  const accepted = new Map<string, AcceptedRoutine>(input.accepted.map(item => [item.automation.routineId, item] as const));
  const detected = new Set(input.routines.map(routine => routine.id));
  const routines: RoutineView[] = [];
  for (const routine of input.routines) {
    const item = accepted.get(routine.id);
    if (!item && input.isDismissed(routine)) continue;
    routines.push(detectedView(routine, item, names));
  }
  for (const item of input.accepted) {
    if (!detected.has(item.automation.routineId)) routines.push(acceptedView(item));
  }
  return { routines, declined: declinedViews(input, names) };
}

/**
 * The name each routine is shown by: the one the local model gave, or the rule-based name, cut to fit. An accepted
 * routine shows the name of its automation, which the person may have changed.
 */
function routineNames(input: KnownRoutinesInput): Map<string, string> {
  const names = new Map<string, string>();
  for (const routine of input.routines) names.set(routine.id, fitName(input.modelName(routine.id) ?? defaultName(routine)));
  for (const item of input.accepted) names.set(item.automation.routineId, item.automation.name);
  return names;
}

function detectedView(routine: Routine, item: AcceptedRoutine | undefined, names: ReadonlyMap<string, string>): RoutineView {
  const view: RoutineView = {
    routineId: routine.id,
    name: names.get(routine.id) ?? fitName(defaultName(routine)),
    status: item ? 'accepted' : 'suggested',
    steps: routine.steps.map(stepView),
    when: describeWhen(routine.when),
  };
  return item ? { ...view, automationId: item.automation.id, level: item.level } : view;
}

/** An accepted routine that is no longer detected. Its steps are the apps its automation focuses, since no site is kept there. */
function acceptedView(item: AcceptedRoutine): RoutineView {
  return {
    routineId: item.automation.routineId,
    name: item.automation.name,
    status: 'accepted',
    steps: automationSteps(item.automation),
    automationId: item.automation.id,
    level: item.level,
  };
}

function stepView(step: RoutineStep): RoutineStepView {
  return {
    app: step.app,
    ...(step.site ? { site: step.site } : {}),
    alternatives: Math.max(0, step.options.length - 1),
  };
}

/** The apps an automation focuses, in order. A parameter shows its default app and how many others it can take. */
function automationSteps(automation: Automation): RoutineStepView[] {
  return automation.steps.flatMap(step => {
    if (step.op !== 'focus_app') return [];
    const param = automation.params.find(candidate => `$${candidate.name}` === step.app);
    return [{ app: param ? param.default : step.app, alternatives: param ? param.options.length - 1 : 0 }];
  });
}

/**
 * The routines the person said no to, latest first. Each shows its count in a row. A dismissal kept by an earlier version
 * has no decline record, so it is listed last with a count of zero.
 */
function declinedViews(input: KnownRoutinesInput, names: ReadonlyMap<string, string>): DeclinedRoutineView[] {
  const dismissed = new Set(input.dismissedIds);
  const recorded = new Set(input.declines.map(record => record.routineId));
  const views: DeclinedRoutineView[] = input.declines.map(record => ({
    routineId: record.routineId,
    name: names.get(record.routineId),
    dismissed: dismissed.has(record.routineId),
    declines: record.count,
    at: record.at,
  }));
  for (const routineId of new Set(input.dismissedIds)) {
    if (!recorded.has(routineId)) views.push({ routineId, name: names.get(routineId), dismissed: true, declines: 0 });
  }
  return views.sort(latestFirst);
}

/** Latest first. A view with no time, a dismissal kept by an earlier version, sorts last. */
function latestFirst(a: DeclinedRoutineView, b: DeclinedRoutineView): number {
  if (a.at === undefined || b.at === undefined) return Number(a.at === undefined) - Number(b.at === undefined);
  return b.at - a.at;
}
