import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  HABITS_WINDOW_DAYS,
  MIN_OBSERVED_DAYS,
  TwinAgent,
  habits,
  type HabitsView,
  type TwinEvent,
  type WindowClass,
} from '../src';
import { at, workdays } from './fixtures';

const DAY = 86_400_000;
/** Midnight at the start of 15 October 2026. The four-week window opens on 17 September. */
const NOW = at(14, 0);

let sequence = 0;

function app(ts: number, name: string, windowClass: WindowClass): TwinEvent {
  sequence += 1;
  return { id: `h${sequence}`, ts, kind: 'focus', app: name, windowClass };
}

function idle(ts: number): TwinEvent {
  sequence += 1;
  return { id: `h${sequence}`, ts, kind: 'idle_start' };
}

function ready(view: HabitsView): Extract<HabitsView, { state: 'ready' }> {
  if (view.state !== 'ready') throw new Error(`Expected a ready summary, got ${view.state}.`);
  return view;
}

/** Every key in a value, at any depth. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value !== 'object' || value === null) return [];
  return Object.entries(value).flatMap(([key, child]) => [key, ...keysOf(child)]);
}

/** Six working days from Monday 5 October: spreadsheet, word, chat, then the browser, then an idle break. */
function usualWeek(): TwinEvent[] {
  return Array.from({ length: 6 }, (_, offset) => [
    app(at(offset + 4, 9), 'microsoft excel', 'spreadsheet'),
    app(at(offset + 4, 9, 10), 'microsoft word', 'document'),
    app(at(offset + 4, 9, 20), 'slack', 'chat'),
    app(at(offset + 4, 9, 30), 'google chrome', 'browser'),
    idle(at(offset + 4, 10)),
  ]).flat();
}

describe('usual hours', () => {
  it('gives each weekday its median start and end hour, Monday first', () => {
    // Two of each weekday in fourteen days. Each weekday starts an hour later than the one before it.
    expect(new Date(at(4, 9)).getDay()).toBe(1);
    const events = Array.from({ length: 14 }, (_, day) => {
      // 1 October 2026 was a Thursday, which is index 3 with Monday first.
      const weekday = (day + 3) % 7;
      return [
        app(at(day, 8 + weekday), 'microsoft excel', 'spreadsheet'),
        app(at(day, 16, 30), 'slack', 'chat'),
        idle(at(day, 17)),
      ];
    }).flat();

    expect(ready(habits(events, NOW)).usualHours).toEqual(
      Array.from({ length: 7 }, (_, weekday) => ({
        weekday,
        days: 2,
        enoughData: true,
        startHour: 8 + weekday,
        endHour: 16.5,
      })),
    );
  });

  it('says a weekday seen on fewer than two days has no hour, rather than guessing one', () => {
    // One working week: a single day for each of Monday to Friday, so no weekday reaches two days.
    const events = Array.from({ length: 5 }, (_, offset) => [
      app(at(offset + 4, 9), 'microsoft excel', 'spreadsheet'),
      app(at(offset + 4, 16), 'slack', 'chat'),
      idle(at(offset + 4, 16, 30)),
    ]).flat();

    const view = ready(habits(events, NOW));
    expect(view.observedDays).toBe(5);
    expect(view.usualHours.map(({ days, enoughData, startHour, endHour }) => [days, enoughData, startHour, endHour])).toEqual([
      [1, false, null, null],
      [1, false, null, null],
      [1, false, null, null],
      [1, false, null, null],
      [1, false, null, null],
      [0, false, null, null],
      [0, false, null, null],
    ]);
  });
});

describe('not enough data', () => {
  it('says so, and names no habit, until enough days are observed', () => {
    const events = Array.from({ length: MIN_OBSERVED_DAYS - 1 }, (_, offset) => [
      app(at(offset + 4, 9), 'microsoft excel', 'spreadsheet'),
      app(at(offset + 4, 16), 'slack', 'chat'),
    ]).flat();

    expect(habits(events, NOW)).toEqual({
      state: 'not_enough_data',
      windowDays: HABITS_WINDOW_DAYS,
      observedDays: MIN_OBSERVED_DAYS - 1,
      requiredDays: MIN_OBSERVED_DAYS,
    });
  });

  it('has no habit to show when nothing was recorded', () => {
    expect(habits([], NOW)).toEqual({
      state: 'not_enough_data',
      windowDays: HABITS_WINDOW_DAYS,
      observedDays: 0,
      requiredDays: MIN_OBSERVED_DAYS,
    });
  });
});

describe('the four-week window', () => {
  it('ignores events older than 28 days, and events after now', () => {
    const recent = usualWeek();
    // Ten days well before the window opens, with switches that would change every figure if they were counted.
    const old = Array.from({ length: 10 }, (_, offset) => [
      app(at(offset - 30, 9), 'figma', 'design'),
      app(at(offset - 30, 9, 5), 'slack', 'chat'),
      idle(at(offset - 30, 10)),
    ]).flat();
    const later = [app(at(20, 9), 'figma', 'design'), app(at(20, 9, 5), 'slack', 'chat')];

    expect(habits([...old, ...recent, ...later], NOW)).toEqual(habits(recent, NOW));
    expect(habits(old, NOW)).toMatchObject({ state: 'not_enough_data', observedDays: 0 });
  });

  it('opens exactly 28 days before now', () => {
    const start = NOW - HABITS_WINDOW_DAYS * DAY;
    const days = Array.from({ length: MIN_OBSERVED_DAYS - 1 }, (_, offset) => app(at(offset + 4, 9), 'slack', 'chat'));

    expect(habits([...days, app(start, 'slack', 'chat')], NOW)).toMatchObject({
      state: 'ready',
      observedDays: MIN_OBSERVED_DAYS,
    });
    expect(habits([...days, app(start - 1, 'slack', 'chat')], NOW)).toMatchObject({
      state: 'not_enough_data',
      observedDays: MIN_OBSERVED_DAYS - 1,
    });
  });
});

describe('determinism', () => {
  it('gives the same summary for the same events, in any order', () => {
    const events = usualWeek();
    const summary = habits(events, NOW);

    expect(habits([...events].reverse(), NOW)).toEqual(summary);
    expect(habits(events, NOW)).toEqual(summary);
  });
});

describe('session length', () => {
  it('gives the median segment length and how many segments there were', () => {
    // Each day holds a 30-minute segment in the morning and a 60-minute one in the afternoon, split by an idle marker.
    const events = Array.from({ length: 6 }, (_, offset) => {
      const day = offset + 4;
      return [
        app(at(day, 9), 'microsoft excel', 'spreadsheet'),
        app(at(day, 9, 30), 'slack', 'chat'),
        idle(at(day, 9, 40)),
        app(at(day, 14), 'microsoft excel', 'spreadsheet'),
        app(at(day, 14, 30), 'microsoft word', 'document'),
        app(at(day, 15), 'slack', 'chat'),
        idle(at(day, 15, 10)),
      ];
    }).flat();

    expect(ready(habits(events, NOW)).sessionMinutes).toEqual({ segments: 12, medianMinutes: 45 });
  });
});

describe('usual app per kind', () => {
  it('names the most used app of each class seen at least five times, with its share', () => {
    // Six days. Browser switches go to Chrome on four days and to Firefox on two. Design switches happen on four days only.
    const events = Array.from({ length: 6 }, (_, offset) => {
      const day = offset + 4;
      return [
        app(at(day, 9), 'microsoft excel', 'spreadsheet'),
        app(at(day, 9, 10), 'microsoft word', 'document'),
        app(at(day, 9, 20), 'slack', 'chat'),
        app(at(day, 9, 30), offset < 4 ? 'google chrome' : 'firefox', 'browser'),
        ...(offset < 4 ? [app(at(day, 9, 35), 'figma', 'design')] : []),
        idle(at(day, 9, 40)),
      ];
    }).flat();

    expect(ready(habits(events, NOW)).usualAppPerKind).toEqual([
      { windowClass: 'browser', switches: 6, app: 'google chrome', sharePct: 67 },
      { windowClass: 'chat', switches: 6, app: 'slack', sharePct: 100 },
      { windowClass: 'document', switches: 6, app: 'microsoft word', sharePct: 100 },
      { windowClass: 'spreadsheet', switches: 6, app: 'microsoft excel', sharePct: 100 },
    ]);
  });

  it('breaks a tie between apps by name, so the answer does not depend on the order of the events', () => {
    // Six days. Slack is used on three days and Teams on the other three, so the two tie inside the chat class.
    const events = Array.from({ length: 6 }, (_, offset) =>
      offset < 3 ? app(at(offset + 4, 9), 'slack', 'chat') : app(at(offset + 4, 9), 'microsoft teams', 'chat'),
    );

    expect(ready(habits(events, NOW)).usualAppPerKind).toEqual([
      { windowClass: 'chat', switches: 6, app: 'microsoft teams', sharePct: 50 },
    ]);
    expect(ready(habits([...events].reverse(), NOW)).usualAppPerKind).toEqual([
      { windowClass: 'chat', switches: 6, app: 'microsoft teams', sharePct: 50 },
    ]);
  });
});

describe('stretches', () => {
  it('gives the median time in one app before a switch, per window class', () => {
    // Six days. Excel holds for ten minutes and Word for ten. Slack holds for 10 to 35 minutes, growing by five a day.
    // Chrome ends each segment, so its time is not a stretch.
    const events = Array.from({ length: 6 }, (_, offset) => {
      const day = offset + 4;
      return [
        app(at(day, 9), 'microsoft excel', 'spreadsheet'),
        app(at(day, 9, 5), 'microsoft excel', 'spreadsheet'),
        app(at(day, 9, 10), 'microsoft word', 'document'),
        app(at(day, 9, 20), 'slack', 'chat'),
        app(at(day, 9, 30 + 5 * offset), 'google chrome', 'browser'),
        idle(at(day, 10, 30)),
      ];
    }).flat();

    expect(ready(habits(events, NOW)).stretchMinutes).toEqual([
      { windowClass: 'chat', stretches: 6, medianMinutes: 22.5 },
      { windowClass: 'document', stretches: 6, medianMinutes: 10 },
      { windowClass: 'spreadsheet', stretches: 6, medianMinutes: 10 },
    ]);
  });

  it('shows no median for a class with fewer than five stretches', () => {
    // Five days. Slack is followed by Excel every day, but Excel is followed by Figma on only two of them.
    const events = Array.from({ length: 5 }, (_, offset) => {
      const day = offset + 4;
      return [
        app(at(day, 9), 'slack', 'chat'),
        app(at(day, 9, 15), 'microsoft excel', 'spreadsheet'),
        ...(offset < 2 ? [app(at(day, 9, 20), 'figma', 'design')] : []),
        idle(at(day, 9, 30)),
      ];
    }).flat();

    expect(ready(habits(events, NOW)).stretchMinutes).toEqual([
      { windowClass: 'chat', stretches: 5, medianMinutes: 15 },
      { windowClass: 'spreadsheet', stretches: 2, medianMinutes: null },
    ]);
  });
});

describe('field names', () => {
  it('stay neutral, with no mood, focus, score or productivity field', () => {
    const keys = keysOf(habits(usualWeek(), NOW));

    expect(keys.filter(key => /focus|score|mood|productiv|engag|stress/i.test(key))).toEqual([]);
  });
});

describe('TwinAgent.habits', () => {
  it('summarises the stored events as the pure function does, and writes nothing', () => {
    const now = at(6, 0);
    const dir = mkdtempSync(join(tmpdir(), 'twin-habits-'));
    const agent = new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => now });
    try {
      agent.updateConfig({ watchBrowsers: true });
      for (const signal of workdays(6)) agent.ingest(signal);
      const before = JSON.stringify(agent.exportAll());

      const summary = agent.habits();
      const stored = (agent.exportAll() as { events: TwinEvent[] }).events;
      expect(summary.state).toBe('ready');
      expect(summary).toEqual(habits(stored, now, agent.configuration.idleGapMs));
      expect(JSON.stringify(agent.exportAll())).toBe(before);
    } finally {
      agent.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
