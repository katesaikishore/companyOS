import type { CaptureHitView, CaptureKind, CaptureSearchRequest } from '@companyos/twin-core';
import { clock, startOfDay } from './format.js';

/** What a search looks at: both kinds, screen text only, or microphone text only. */
export type RecallKind = 'all' | 'screen' | 'audio';

/** How far back a search looks. Today starts at local midnight. The week is today and the six days before it. */
export type RecallRange = 'today' | 'week';

/** The longest text a search takes. The core engine refuses a longer one. */
export const RECALL_TEXT_MAX = 200;

/** Text is kept this long. The core engine's RETENTION_DAYS (agent.ts) is the rule. The copy repeats it, so it is written here. */
export const TEXT_KEPT_DAYS = 90;

export const KIND_OPTIONS: ReadonlyArray<{ value: RecallKind; label: string }> = [
  { value: 'all', label: 'Everything' },
  { value: 'screen', label: 'Screen' },
  { value: 'audio', label: 'Microphone' },
];

export const RANGE_OPTIONS: ReadonlyArray<{ value: RecallRange; label: string }> = [
  { value: 'today', label: 'Today' },
  { value: 'week', label: 'Last 7 days' },
];

/** The short name of each kind of item, as a chip shows it. */
export const KIND_LABEL: Record<CaptureKind, string> = {
  screen: 'Screen',
  audio: 'Microphone',
};

/** Every fixed piece of copy on the Recall page. Kept together so the wording is checked in one place. */
export const RECALL_COPY = {
  title: 'Recall',
  note: 'Search the text the twin read on the screen or heard on the microphone. It is encrypted on this device. Nothing is recorded until you turn it on in Settings or setup.',
  channels: 'What is being recorded',
  screenChannel: 'Screen text',
  audioChannel: 'Microphone text',
  recording: 'Screen text is being recorded.',
  searchLabel: 'Words to search for',
  placeholder: 'Words you remember',
  search: 'Search',
  kindLabel: 'Kind',
  rangeLabel: 'Range',
  results: 'Results',
  promptTitle: 'Nothing searched yet.',
  prompt: 'Type words and press Enter, or pick a range to list what was recorded.',
  noMatchTitle: 'Nothing matched.',
  noMatch: 'Try other words, or a wider range.',
  offTitle: 'Nothing recorded yet.',
  offText: 'Screen text and microphone text are both off. Turn one on in Settings to start.',
  showImage: 'Show image',
  hideImage: 'Hide image',
  imageLoading: 'Loading image…',
  imageGone: 'This image is not available. It may have been removed when its keep period ended.',
} as const;

/**
 * The window a range covers, in ms, both ends inclusive. Days are the person's local days, so the window starts at
 * their midnight and ends just before the next one.
 */
export function rangeFor(range: RecallRange, now: number): { from: number; to: number } {
  const end = new Date(startOfDay(now));
  end.setDate(end.getDate() + 1);
  const start = new Date(end);
  start.setDate(start.getDate() - (range === 'week' ? 7 : 1));
  return { from: start.getTime(), to: end.getTime() - 1 };
}

/** The request the search page sends. The kind is left out for "everything", and the words are trimmed and capped. */
export function searchRequest(query: { text: string; kind: RecallKind; range: RecallRange }, now: number): CaptureSearchRequest {
  const { from, to } = rangeFor(query.range, now);
  return {
    text: query.text.trim().slice(0, RECALL_TEXT_MAX),
    ...(query.kind === 'all' ? {} : { kind: query.kind }),
    from,
    to,
  };
}

/** One clock hour of hits. `hour` is the start of that local hour, in ms. */
export interface HourGroup {
  hour: number;
  /** The hour's start as a clock time, such as 09:00. */
  label: string;
  /** The hits in this hour, newest first. */
  hits: CaptureHitView[];
}

/** Groups hits by the local hour they were captured in. The hours run newest first, and so do the hits inside each. */
export function groupByHour(hits: readonly CaptureHitView[]): HourGroup[] {
  const groups = new Map<number, CaptureHitView[]>();
  for (const hit of hits) {
    const start = new Date(hit.ts);
    start.setMinutes(0, 0, 0);
    const list = groups.get(start.getTime());
    if (list) list.push(hit);
    else groups.set(start.getTime(), [hit]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => b - a)
    .map(([hour, items]) => ({
      hour,
      label: clock(hour),
      hits: items.sort((a, b) => b.ts - a.ts),
    }));
}
