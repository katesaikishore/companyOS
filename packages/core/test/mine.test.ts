import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { mineRoutines, normalizeSignal, segment, stepKey, type RawSignal, type TwinEvent } from '../src';
import { SECRET_QUERY, at, siteWorkdays, workdays } from './fixtures';

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

  it('records when a routine was last seen, the start of its latest occurrence', () => {
    const routines = mineRoutines(segment(events(workdays(10)), 60 * 60_000));
    const routine = routines.find(r => r.steps.map(s => s.windowClass).join('>') === 'spreadsheet>mail>chat>browser');

    expect(routine?.lastSeenAt).toBe(at(9, 9));
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

describe('browser steps are keyed by site', () => {
  it('keeps two sequences on different sites apart, where the window class alone merged them', () => {
    const routines = mineRoutines(segment(events(siteWorkdays(4)), 60 * 60_000));
    expect(routines).toHaveLength(2);
    const mail = routines.find(routine => routine.steps.some(step => step.site === 'mail.google.com/mail'));
    const jira = routines.find(routine => routine.steps.some(step => step.site === 'jira.example.com/browse'));

    expect(mail).toMatchObject({ support: 4, days: 4 });
    expect(jira).toMatchObject({ support: 4, days: 4 });
    expect(mail?.id).not.toBe(jira?.id);
    expect(mail?.steps.map(step => step.site)).toEqual([
      undefined,
      'mail.google.com/mail',
      'docs.google.com/spreadsheets',
      undefined,
    ]);
    const mixed = routines.filter(routine => {
      const sites = routine.steps.map(step => step.site);
      return sites.includes('mail.google.com/mail') && sites.includes('jira.example.com/browse');
    });
    expect(mixed).toEqual([]);
  });

  it('keeps the query string and the deeper path out of every routine', () => {
    const text = JSON.stringify(mineRoutines(segment(events(siteWorkdays(4)), 60 * 60_000)));
    expect(text).not.toContain(SECRET_QUERY);
    expect(text).not.toContain('1ab2cd3ef4567890');
  });

  it('still merges consecutive visits to one site into one step', () => {
    const signals: RawSignal[] = [];
    for (let day = 0; day < 4; day++) {
      signals.push(
        { kind: 'focus', ts: at(day, 9), app: 'Microsoft Excel' },
        { kind: 'focus', ts: at(day, 9, 10), app: 'Google Chrome', url: 'https://mail.google.com/mail/u/0/#inbox' },
        { kind: 'focus', ts: at(day, 9, 12), app: 'Google Chrome', url: 'https://mail.google.com/mail/u/1/#sent' },
        { kind: 'focus', ts: at(day, 9, 20), app: 'Slack' },
        { kind: 'idle_start', ts: at(day, 9, 30) },
      );
    }
    const routines = mineRoutines(segment(events(signals), 60 * 60_000));

    expect(routines).toHaveLength(1);
    expect(routines[0].steps.map(step => step.windowClass)).toEqual(['spreadsheet', 'browser', 'chat']);
    expect(routines[0].steps[1].site).toBe('mail.google.com/mail');
  });

  it('gives a site routine the id of the hash of its key', () => {
    const routines = mineRoutines(segment(events(siteWorkdays(4)), 60 * 60_000));
    const mail = routines.find(routine => routine.steps.some(step => step.site === 'mail.google.com/mail'));
    const key = 'spreadsheet>browser@mail.google.com/mail>browser@docs.google.com/spreadsheets>chat';

    expect(mail?.id).toBe(createHash('sha256').update(key).digest('hex').slice(0, 12));
  });
});

describe('routine ids for events without a site', () => {
  it('gives a routine with no browser step the id it had before, the hash of its window classes', () => {
    const signals: RawSignal[] = [];
    for (let day = 0; day < 4; day++) {
      signals.push(
        { kind: 'focus', ts: at(day, 9), app: 'Microsoft Excel' },
        { kind: 'focus', ts: at(day, 9, 20), app: 'Microsoft Outlook' },
        { kind: 'focus', ts: at(day, 9, 30), app: 'Slack' },
        { kind: 'idle_start', ts: at(day, 9, 40) },
      );
    }
    const routines = mineRoutines(segment(events(signals), 60 * 60_000));

    expect(routines).toHaveLength(1);
    expect(routines[0].id).toBe(createHash('sha256').update('spreadsheet>mail>chat').digest('hex').slice(0, 12));
  });

  it('keeps a browser run with no site as one step, keyed by its window class', () => {
    const signals: RawSignal[] = [];
    for (let day = 0; day < 4; day++) {
      signals.push(
        { kind: 'focus', ts: at(day, 9), app: 'Microsoft Excel' },
        { kind: 'focus', ts: at(day, 9, 10), app: 'Google Chrome' },
        { kind: 'focus', ts: at(day, 9, 12), app: 'Google Chrome' },
        { kind: 'focus', ts: at(day, 9, 20), app: 'Slack' },
        { kind: 'idle_start', ts: at(day, 9, 30) },
      );
    }
    const routines = mineRoutines(segment(events(signals), 60 * 60_000));

    expect(routines).toHaveLength(1);
    expect(routines[0].steps.map(step => step.windowClass)).toEqual(['spreadsheet', 'browser', 'chat']);
    expect(routines[0].steps[1].site).toBeUndefined();
    expect(routines[0].id).toBe(createHash('sha256').update('spreadsheet>browser>chat').digest('hex').slice(0, 12));
  });
});

describe('stepKey', () => {
  it('keys a browser step by its class and site, and an other app by its normalised name', () => {
    expect(stepKey({ windowClass: 'browser', app: 'Google Chrome' })).toBe('browser');
    expect(stepKey({ windowClass: 'browser', app: 'Google Chrome', urlTemplate: 'mail.google.com/mail' })).toBe(
      'browser@mail.google.com/mail',
    );
    expect(stepKey({ windowClass: 'other', app: '  Vendor Tool.app ' })).toBe('other:vendor tool');
  });

  it('removes any ">" from a name or a site, so the joined key keeps one part per step', () => {
    expect(stepKey({ windowClass: 'browser', app: 'Google Chrome', urlTemplate: 'a>b.example.com/x' })).toBe(
      'browser@ab.example.com/x',
    );
    expect(stepKey({ windowClass: 'other', app: 'Tool > Name' })).not.toContain('>');
  });

  it('counts the steps of a routine correctly when a site has a ">" in it', () => {
    const stream: TwinEvent[] = [];
    for (let day = 0; day < 4; day++) {
      stream.push(
        { id: `a${day}`, ts: at(day, 9), kind: 'focus', app: 'Microsoft Excel', windowClass: 'spreadsheet' },
        {
          id: `b${day}`,
          ts: at(day, 9, 10),
          kind: 'focus',
          app: 'Google Chrome',
          windowClass: 'browser',
          urlTemplate: 'a>b.example.com/x',
        },
        { id: `c${day}`, ts: at(day, 9, 20), kind: 'focus', app: 'Slack', windowClass: 'chat' },
        { id: `d${day}`, ts: at(day, 9, 30), kind: 'idle_start' },
      );
    }
    const routines = mineRoutines(segment(stream, 60 * 60_000));

    expect(routines.map(routine => routine.steps.length)).toEqual([3]);
  });
});
