import type { TwinEvent } from './types';

export interface Segment {
  id: string;
  startTs: number;
  endTs: number;
  /** Focus events only, in order. Each carries app and window class, never content. */
  events: TwinEvent[];
}

/**
 * Splits the event stream into work segments. A segment ends at an idle start, a lock,
 * or a gap between focus events longer than idleGapMs.
 */
export function segment(events: readonly TwinEvent[], idleGapMs: number): Segment[] {
  const ordered = [...events].sort((a, b) => a.ts - b.ts);
  const segments: Segment[] = [];
  let current: TwinEvent[] = [];

  const close = (): void => {
    const focus = current.filter(event => event.kind === 'focus' && event.app && event.windowClass);
    if (focus.length > 0) {
      segments.push({
        id: `${focus[0].ts.toString(36)}-${segments.length}`,
        startTs: focus[0].ts,
        endTs: focus[focus.length - 1].ts,
        events: focus,
      });
    }
    current = [];
  };

  for (const event of ordered) {
    if (event.kind === 'idle_start' || event.kind === 'lock') {
      close();
      continue;
    }
    if (event.kind !== 'focus') continue;
    const last = current[current.length - 1];
    if (last && event.ts - last.ts > idleGapMs) close();
    current.push(event);
  }
  close();
  return segments;
}
