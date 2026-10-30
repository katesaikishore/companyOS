import { describe, expect, it } from 'vitest';
import { mineRoutines, normalizeSignal, segment, type TwinEvent } from '../src';
import { at, workdays } from './fixtures';

const EXCLUDED = ['1password'];

function events(signals: ReturnType<typeof workdays>): TwinEvent[] {
  return signals
    .map((signal, index) => normalizeSignal(signal, { excludedApps: EXCLUDED, watchBrowsers: true, newId: () => `e${index}` }))
    .filter((event): event is TwinEvent => event !== null);
}

describe('segment', () => {
  it('splits at idle, lock and long gaps', () => {
    const stream: TwinEvent[] = [
      { id: '1', ts: at(0, 9), kind: 'focus', app: 'slack', windowClass: 'chat' },
      { id: '2', ts: at(0, 9, 5), kind: 'idle_start' },
      { id: '3', ts: at(0, 10), kind: 'focus', app: 'slack', windowClass: 'chat' },
      { id: '4', ts: at(0, 10, 1), kind: 'lock' },
      { id: '5', ts: at(0, 11), kind: 'focus', app: 'slack', windowClass: 'chat' },
      { id: '6', ts: at(0, 11, 1), kind: 'focus', app: 'slack', windowClass: 'chat' },
      { id: '7', ts: at(0, 16), kind: 'focus', app: 'slack', windowClass: 'chat' },
    ];
    expect(segment(stream, 60 * 60_000)).toHaveLength(4);
  });
});

describe('mineRoutines', () => {
  it('finds a planted routine across days, with its variable app as an option', () => {
    const segments = segment(events(workdays(10)), 60 * 60_000);
    const routines = mineRoutines(segments);
    const routine = routines.find(r => r.steps.map(s => s.windowClass).join('>') === 'spreadsheet>mail>chat>browser');

    expect(routine).toBeDefined();
    expect(routine?.support).toBe(10);
    expect(routine?.days).toBe(10);
    expect(routine?.steps[0].options[0]).toBe('microsoft excel');
    expect([...(routine?.steps[0].options ?? [])].sort()).toEqual(['libreoffice calc', 'microsoft excel']);
    expect(routine?.steps[1].options).toEqual(['microsoft outlook']);
  });

  it('reports only maximal routines', () => {
    const routines = mineRoutines(segment(events(workdays(10)), 60 * 60_000));
    const keys = routines.map(r => r.steps.map(s => s.windowClass).join('>'));
    expect(keys).not.toContain('spreadsheet>mail>chat');
    expect(keys).not.toContain('mail>chat>browser');
  });

  it('does not invent routines from one-off noise', () => {
    const noise = Array.from({ length: 10 }, (_, day) => [
      { kind: 'focus' as const, ts: at(day, 9), app: `Vendor Tool ${day}` },
      { kind: 'focus' as const, ts: at(day, 9, 10), app: `Slack` },
      { kind: 'idle_start' as const, ts: at(day, 9, 20) },
    ]).flat();
    expect(mineRoutines(segment(events(noise), 60 * 60_000))).toEqual([]);
  });

  it('respects the day threshold', () => {
    const routines = mineRoutines(segment(events(workdays(2)), 60 * 60_000));
    expect(routines).toEqual([]);
  });
});
