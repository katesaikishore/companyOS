import { describe, expect, it } from 'vitest';
import type { CaptureHitView } from '@companyos/twin-core';
import { RECALL_TEXT_MAX, groupByHour, rangeFor, searchRequest } from '../src/renderer/recall-model';
import { routeFromHash, routeKey } from '../src/renderer/store';

/** Local time, as the person sees it. October 2026. */
function at(day: number, hour: number, minute = 0): number {
  return new Date(2026, 9, day, hour, minute).getTime();
}

function hit(ts: number, overrides: Partial<CaptureHitView> = {}): CaptureHitView {
  return { kind: 'screen', id: `item-${ts}`, ts, app: 'microsoft word', snippet: 'quarterly plan', ...overrides };
}

describe('groupByHour', () => {
  it('groups hits by the local hour, newest hour first, and the hits newest first inside each hour', () => {
    const groups = groupByHour([hit(at(1, 9, 5)), hit(at(1, 10, 10)), hit(at(1, 9, 40)), hit(at(1, 8, 59))]);

    expect(groups.map(group => group.label)).toEqual(['10:00', '09:00', '08:00']);
    expect(groups[1].hour).toBe(at(1, 9));
    expect(groups[1].hits.map(item => item.ts)).toEqual([at(1, 9, 40), at(1, 9, 5)]);
    expect(groups[0].hits).toHaveLength(1);
  });

  it('keeps hits from different days in separate hour groups', () => {
    const groups = groupByHour([hit(at(2, 9, 15)), hit(at(1, 9, 15))]);

    expect(groups.map(group => group.hour)).toEqual([at(2, 9), at(1, 9)]);
  });

  it('returns no groups for no hits', () => {
    expect(groupByHour([])).toEqual([]);
  });
});

describe('rangeFor', () => {
  it('starts today at local midnight and ends just before the next midnight', () => {
    expect(rangeFor('today', at(1, 15, 30))).toEqual({ from: at(1, 0), to: at(2, 0) - 1 });
  });

  it('is the same window at any time of the day, including the first minute', () => {
    expect(rangeFor('today', at(1, 0, 0))).toEqual({ from: at(1, 0), to: at(2, 0) - 1 });
    expect(rangeFor('today', at(1, 23, 59))).toEqual({ from: at(1, 0), to: at(2, 0) - 1 });
  });

  it('covers the last seven calendar days, today included', () => {
    // Seven days ending on 1 October start on 25 September.
    expect(rangeFor('week', at(1, 15, 30))).toEqual({ from: new Date(2026, 8, 25).getTime(), to: at(2, 0) - 1 });
  });
});

describe('searchRequest', () => {
  it('trims the words and leaves the kind out for everything', () => {
    const request = searchRequest({ text: '  invoice  ', kind: 'all', range: 'today' }, at(1, 15));

    expect(request).toEqual({ text: 'invoice', from: at(1, 0), to: at(2, 0) - 1 });
    expect('kind' in request).toBe(false);
  });

  it('passes a screen or microphone kind through', () => {
    expect(searchRequest({ text: '', kind: 'screen', range: 'week' }, at(1, 15)).kind).toBe('screen');
    expect(searchRequest({ text: '', kind: 'audio', range: 'week' }, at(1, 15)).kind).toBe('audio');
  });

  it('caps the words at the length the core engine accepts', () => {
    const long = 'a'.repeat(RECALL_TEXT_MAX + 50);

    expect(searchRequest({ text: long, kind: 'all', range: 'today' }, at(1, 15)).text).toHaveLength(RECALL_TEXT_MAX);
  });
});

describe('recall route', () => {
  it('reads #/recall and names it back the same way', () => {
    expect(routeFromHash('#/recall')).toEqual({ name: 'recall' });
    expect(routeKey({ name: 'recall' })).toBe('#/recall');
  });
});
