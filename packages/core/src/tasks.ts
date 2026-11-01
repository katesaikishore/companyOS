import { z } from 'zod';
import type { DayTasksView, TaskView } from './contract';
import { segment, type Segment } from './segment';
import type { TwinEvent } from './types';

const MINUTE_MS = 60_000;
const DAY_KEY = /^\d{4}-\d{2}-\d{2}$/;
/** A segment id: its start time in base 36, a dash, and its index among the day's segments. */
const SEGMENT_ID = /^[0-9a-z]{1,12}-\d{1,6}$/;

/**
 * The longest break that keeps two segments in one task. A design value: a longer break is taken as the end of one piece
 * of work. The break runs from the moment the earlier segment's last stretch ended (see stretchEnded) to the first focus
 * event of the later one.
 */
export const TASK_GAP_MS = 30 * MINUTE_MS;
/** The longest name the person can give a task. */
export const TASK_NAME_MAX = 60;
/** Apps named in a task's rule-based name, such as "Microsoft Excel and Slack". A design value. */
const NAMED_APPS = 2;

/**
 * One decision the person made about a day's tasks. It holds the action and the ids it refers to, never app content. A
 * rename holds the name the person typed for the task: their own label, not text from an app. An empty name takes the
 * rule-based name back. The schema is strict, so a field the page should not send is refused.
 */
const DayKey = z.string().regex(DAY_KEY);
const SegmentId = z.string().regex(SEGMENT_ID);
export const TaskDecisionSchema = z.discriminatedUnion('kind', [
  z.object({ day: DayKey, kind: z.literal('confirm'), taskId: SegmentId }).strict(),
  z.object({ day: DayKey, kind: z.literal('rename'), taskId: SegmentId, name: z.string().trim().max(TASK_NAME_MAX) }).strict(),
  z.object({ day: DayKey, kind: z.literal('merge'), taskId: SegmentId, nextTaskId: SegmentId }).strict(),
  z.object({ day: DayKey, kind: z.literal('split'), taskId: SegmentId, segmentId: SegmentId }).strict(),
]);
export type TaskDecision = z.infer<typeof TaskDecisionSchema>;

/** Checks a decision from the page. The error never echoes the input, so a typed name cannot reach the error text. */
export function parseTaskDecision(input: unknown): TaskDecision {
  const parsed = TaskDecisionSchema.safeParse(input);
  if (!parsed.success) throw new Error('That task change is not valid.');
  return parsed.data;
}

/** A local calendar day, as YYYY-MM-DD. Tasks are grouped by the day the person lived, not the UTC day. */
export function dayKeyOf(ts: number): string {
  const date = new Date(ts);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight at the start of a day, and at the start of the next one. */
export function dayBounds(day: string): { start: number; end: number } {
  const [year, month, date] = day.split('-').map(Number);
  return { start: new Date(year, month - 1, date).getTime(), end: new Date(year, month - 1, date + 1).getTime() };
}

/**
 * The tasks of one local day, with the person's decisions applied in the order they were made. The events are cut to
 * the day and segmented as habits are, so a task never spans a break the person took. Nothing is stored here.
 */
export function tasksForDay(
  events: readonly TwinEvent[],
  decisions: readonly TaskDecision[],
  day: string,
  idleGapMs: number,
): DayTasksView {
  return { day, tasks: dayTaskList(events, decisions, day, idleGapMs).map(taskView) };
}

/**
 * Whether a new decision fits the day's tasks as they stand. A decision that does not fit is refused before it is
 * stored, so a stale click (a task already merged away, say) cannot leave an unusable record behind.
 */
export function decisionFits(
  events: readonly TwinEvent[],
  decisions: readonly TaskDecision[],
  idleGapMs: number,
  decision: TaskDecision,
): boolean {
  return applyDecision(dayTaskList(events, decisions, decision.day, idleGapMs), decision) !== undefined;
}

/** A task before any decision: consecutive segments, with the name the person gave it, if any. */
interface WorkTask {
  segments: Segment[];
  /** Undefined keeps the rule-based name. */
  name?: string;
  confirmed: boolean;
}

/**
 * The rule, in full. Segments are taken in time order. Each one joins the task before it when the break between them is at
 * most TASK_GAP_MS and they share at least half of each segment's apps. Each segment is held to its own count, so a
 * segment with four apps needs two of them in the next one. Otherwise the segment starts a new task. A task is named by
 * its two most used apps, counted in focus switches, and a task with one app takes that app's name.
 */
function groupSegments(segments: readonly Segment[]): WorkTask[] {
  const tasks: WorkTask[] = [];
  for (const work of segments) {
    const current = tasks.at(-1);
    const previous = current?.segments.at(-1);
    if (current && previous && joins(previous, work)) current.segments.push(work);
    else tasks.push({ segments: [work], confirmed: false });
  }
  return tasks;
}

function joins(before: Segment, after: Segment): boolean {
  if (after.startTs - before.endTs > TASK_GAP_MS) return false;
  const first = appsOf(before);
  const second = appsOf(after);
  const shared = [...first].filter(app => second.has(app)).length;
  return shared * 2 >= first.size && shared * 2 >= second.size;
}

function appsOf(work: Segment): Set<string> {
  return new Set(work.events.flatMap(event => (event.app ? [event.app] : [])));
}

/** The apps used across some segments, most used first. A tie goes to the name that sorts first. */
function appUsage(segments: readonly Segment[]): string[] {
  const counts = new Map<string, number>();
  for (const work of segments) {
    for (const event of work.events) {
      if (event.app) counts.set(event.app, (counts.get(event.app) ?? 0) + 1);
    }
  }
  return [...counts].sort(([a, x], [b, y]) => y - x || compareText(a, b)).map(([app]) => app);
}

/**
 * Applies the decisions in order to the day's rule-based tasks. A decision that does not fit the tasks at its turn is
 * skipped, so a stale record cannot change the day.
 */
function applyDecisions(tasks: WorkTask[], decisions: readonly TaskDecision[]): WorkTask[] {
  return decisions.reduce<WorkTask[]>((current, decision) => applyDecision(current, decision) ?? current, tasks);
}

/**
 * One decision applied to the tasks. Returns undefined when it does not fit: its task is gone, a merge names a task that
 * is not the next one, or a split names a segment that is not a later one inside the task. A task keeps the id of its
 * first segment, so a later decision still finds it. A merge keeps the earlier task's name, or the later one's when the
 * earlier one has none. A split leaves the name with the earlier part.
 */
function applyDecision(tasks: readonly WorkTask[], decision: TaskDecision): WorkTask[] | undefined {
  const index = tasks.findIndex(task => idOf(task) === decision.taskId);
  if (index === -1) return undefined;
  const task = tasks[index];
  switch (decision.kind) {
    case 'confirm':
      return replaceAt(tasks, index, 1, [{ ...task, confirmed: true }]);
    case 'rename':
      return replaceAt(tasks, index, 1, [{ ...task, name: decision.name === '' ? undefined : decision.name, confirmed: true }]);
    case 'merge': {
      const next = tasks[index + 1];
      if (!next || idOf(next) !== decision.nextTaskId) return undefined;
      const merged: WorkTask = { segments: [...task.segments, ...next.segments], name: task.name ?? next.name, confirmed: true };
      return replaceAt(tasks, index, 2, [merged]);
    }
    case 'split': {
      const at = task.segments.findIndex(work => work.id === decision.segmentId);
      if (at <= 0) return undefined;
      return replaceAt(tasks, index, 1, [
        { ...task, segments: task.segments.slice(0, at), confirmed: true },
        { segments: task.segments.slice(at), confirmed: true },
      ]);
    }
  }
}

function dayTaskList(events: readonly TwinEvent[], decisions: readonly TaskDecision[], day: string, idleGapMs: number): WorkTask[] {
  const { start, end } = dayBounds(day);
  const inDay = events.filter(event => event.ts >= start && event.ts < end);
  const works = stretchEnded(segment(inDay, idleGapMs), inDay);
  return applyDecisions(groupSegments(works), decisions.filter(decision => decision.day === day));
}

/**
 * The segments with each end moved to when its last stretch ended: at the idle start or lock that closed it, or at the
 * next focus event. Segments close only at an idle start, a lock or a long gap, so the next focus event after a segment's
 * last one is where the following segment begins. A last stretch with no later event keeps its last focus event as its
 * end. So an app left in front without an idle signal counts as work, not as a break. The events are in time order, and
 * each segment's last focus event is found by identity, since segments hold the events themselves.
 */
function stretchEnded(segments: readonly Segment[], events: readonly TwinEvent[]): Segment[] {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  let cursor = 0;
  return segments.map(work => {
    const last = work.events[work.events.length - 1];
    const at = ordered.indexOf(last, cursor);
    if (at === -1) return work;
    cursor = at + 1;
    let next = at + 1;
    while (next < ordered.length && !endsStretch(ordered[next])) next++;
    return { ...work, endTs: next < ordered.length ? ordered[next].ts : work.endTs };
  });
}

/** An event that ends a stretch: an idle start, a lock, or a focus event that starts the next segment. */
function endsStretch(event: TwinEvent): boolean {
  return event.kind === 'idle_start' || event.kind === 'lock' || event.kind === 'focus';
}

function taskView(task: WorkTask): TaskView {
  const apps = appUsage(task.segments);
  const first = task.segments[0];
  const last = task.segments[task.segments.length - 1];
  return {
    id: idOf(task),
    name: task.name ?? defaultName(apps),
    renamed: task.name !== undefined,
    apps,
    startTs: first.startTs,
    endTs: last.endTs,
    segments: task.segments.map(work => ({ id: work.id, startTs: work.startTs })),
    confirmed: task.confirmed,
  };
}

/** The two most used apps, title-cased and joined with "and". Stored names are lower case; only the display changes. */
function defaultName(apps: readonly string[]): string {
  return apps.slice(0, NAMED_APPS).map(titleCaseName).join(' and ');
}

/** A task keeps the id of its first segment, so the id does not change when later work joins it. */
function idOf(task: WorkTask): string {
  return task.segments[0].id;
}

function replaceAt<T>(items: readonly T[], index: number, count: number, replacement: T[]): T[] {
  return [...items.slice(0, index), ...replacement, ...items.slice(index + count)];
}

function titleCaseName(name: string): string {
  return name.replace(/(^|[\s-])(\S)/g, (_, lead: string, letter: string) => lead + letter.toUpperCase());
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** A plain comparison. Locale collation could order names differently on each machine. */
function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
