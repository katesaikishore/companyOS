import type {
  DeclinedRoutineView,
  RoutineStepView,
  RoutineView,
  SessionMinutesView,
  StretchMinutesView,
  TaskView,
  UsualAppView,
  UsualHoursView,
  WindowClass,
} from '@companyos/twin-core';
import { formatWhen, plural, titleCase } from './format.js';
import { levelLabel } from './labels.js';
import { tasksNote } from './review-model.js';

/** Every fixed piece of copy on the page. Kept together so the wording is checked in one place. */
export const COPY = {
  title: 'What the twin knows',
  note: 'Everything here stays on this device, encrypted. Delete everything in Settings removes it.',
  routines: 'Your routines',
  routinesEmpty: 'No routines yet.',
  routinesEmptyText: 'The twin needs about three days of repetition to notice one.',
  forget: 'Forget',
  openAutomation: 'Open automation',
  declined: 'Things you said no to',
  declinedEmpty: 'Nothing declined.',
  declinedEmptyText: 'Routines you say not now to, or dismiss, are listed here. Reset lets the twin suggest one again.',
  reset: 'Reset',
  unseen: 'A routine the twin no longer sees',
  habits: 'Your habits',
  usualHours: 'Usual hours',
  session: 'Typical session',
  usualApps: 'Usual app for each kind of work',
  stretch: 'Stretch before switching',
  notEnoughDays: 'Not enough days yet',
  noSwitches: 'Not enough switches yet.',
  noSession: 'Not enough sessions yet',
  noStretch: 'Not enough yet',
  tasks: "Today's tasks",
  nothingToReview: 'Nothing to review yet.',
  openReview: "Open today's review",
} as const;

/** The plain words for the kind of work each window class stands for. */
export const KIND_NAMES: Record<WindowClass, string> = {
  browser: 'Browsing',
  editor: 'Code',
  spreadsheet: 'Spreadsheets',
  document: 'Documents',
  mail: 'Email',
  chat: 'Chat',
  terminal: 'Terminal',
  design: 'Design',
  other: 'Other apps',
};

/** Weekday names, Monday first, as the habits view counts them. */
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function weekdayName(weekday: number): string {
  return WEEKDAYS[weekday] ?? '';
}

/** A time of day from hours with a fraction, such as 9.5, as "09:30". */
export function clockOf(hour: number): string {
  const minutes = Math.round(hour * 60);
  const hours = Math.floor(minutes / 60) % 24;
  const rest = minutes % 60;
  return `${String(hours).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
}

/** The usual hours of one weekday. Until enough days are seen, the line says so instead of naming an hour. */
export function usualHoursLine(day: UsualHoursView): string {
  if (!day.enoughData || day.startHour === null || day.endHour === null) return COPY.notEnoughDays;
  return `${clockOf(day.startHour)} to ${clockOf(day.endHour)}`;
}

/** Minutes as a plain length: "About 45 min", or "Under a minute" for less than one. */
function minutesLine(minutes: number): string {
  return minutes < 1 ? 'Under a minute' : `About ${Math.round(minutes)} min`;
}

export function sessionLine(view: SessionMinutesView): string {
  if (view.medianMinutes === null) return COPY.noSession;
  return `${minutesLine(view.medianMinutes)}, over ${plural(view.segments, 'session')}`;
}

/** The section is titled "Stretch before switching", so the line names only the length. */
export function stretchLine(view: StretchMinutesView): string {
  if (view.medianMinutes === null) return COPY.noStretch;
  return minutesLine(view.medianMinutes);
}

/** The app a kind of work uses most, and its share of the switches into that kind. */
export function usualAppLine(view: UsualAppView): string {
  return `${titleCase(view.app)}, ${view.sharePct}% of switches`;
}

/** Shown in place of the habits while too few days are seen. It names the days seen and the days needed, and no habit. */
export function notEnoughLine(view: { observedDays: number; requiredDays: number }): string {
  return `The twin has seen ${plural(view.observedDays, 'day')}. It needs ${plural(view.requiredDays, 'day')} before it describes how you work.`;
}

/** One step of a routine: its app, how many other apps it can be, and its site for a browser. */
export function stepLabel(step: RoutineStepView): string {
  const others = step.alternatives > 0 ? ` or ${plural(step.alternatives, 'other app')}` : '';
  const site = step.site ? ` · ${step.site}` : '';
  return `${titleCase(step.app)}${others}${site}`;
}

/** The status of a routine: waiting for an answer, or an automation at its level. */
export function routineStatusLabel(view: RoutineView): string {
  if (view.status === 'suggested') return 'Suggested';
  return view.level === undefined ? 'Automation' : `Automation · ${levelLabel(view.level)}`;
}

/** What the person said: "Not a routine" for a dismissal, "Not now" for an offer. */
export function declinedKindLabel(view: DeclinedRoutineView): string {
  return view.dismissed ? 'Not a routine' : 'Not now';
}

/** The count in a row and when the latest answer was, joined. A dismissal from an earlier version has neither, so it is empty. */
export function declinedMeta(view: DeclinedRoutineView, now: number): string {
  const count = view.declines === 0 ? undefined : view.declines === 1 ? 'Said no once' : `Said no ${view.declines} times in a row`;
  const when = view.at === undefined ? undefined : formatWhen(view.at, now);
  return [count, when].filter((part): part is string => part !== undefined).join(' · ');
}

/** Today's tasks in one line: how many there are, and how many wait for the person. */
export function tasksLine(tasks: readonly Pick<TaskView, 'confirmed'>[]): string {
  if (tasks.length === 0) return COPY.nothingToReview;
  return `${plural(tasks.length, 'task')} today · ${tasksNote(tasks)}`;
}
