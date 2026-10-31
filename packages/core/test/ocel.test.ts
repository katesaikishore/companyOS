import { describe, expect, it } from 'vitest';
import { normalizeSignal, toOcel2, type Ocel2Log, type TwinEvent } from '../src';
import { SECRET_QUERY, workdays } from './fixtures';

const EXCLUDED = ['1password', 'bitwarden'];

/** Runs raw signals through the same redaction the store applies, so the events are the ones the store holds. */
function storedEvents(days: number): TwinEvent[] {
  let next = 0;
  const options = { excludedApps: EXCLUDED, watchBrowsers: true, newId: () => `evt-${String(++next).padStart(4, '0')}` };
  return workdays(days)
    .map(signal => normalizeSignal(signal, options))
    .filter((event): event is TwinEvent => event !== null);
}

const FIXTURE: TwinEvent[] = [
  { id: 'a', ts: Date.UTC(2026, 9, 30, 9, 0), kind: 'focus', app: 'microsoft excel', windowClass: 'spreadsheet' },
  {
    id: 'b',
    ts: Date.UTC(2026, 9, 30, 9, 5),
    kind: 'focus',
    app: 'google chrome',
    windowClass: 'browser',
    urlTemplate: 'docs.example.com/doc',
  },
  { id: 'c', ts: Date.UTC(2026, 9, 30, 9, 10), kind: 'idle_start' },
  { id: 'd', ts: Date.UTC(2026, 9, 30, 10, 0), kind: 'idle_end' },
];

/** The rules an OCEL 2.0 consumer relies on: declared types, unique ids and relationships that point at real objects. */
function expectConsistent(log: Ocel2Log): void {
  const objectTypes = new Set(log.objectTypes.map(type => type.name));
  const eventTypes = new Map(log.eventTypes.map(type => [type.name, new Set(type.attributes.map(a => a.name))]));
  const objectIds = new Set(log.objects.map(object => object.id));
  expect(objectIds.size).toBe(log.objects.length);
  expect(new Set(log.events.map(event => event.id)).size).toBe(log.events.length);
  for (const object of log.objects) {
    expect(objectTypes.has(object.type)).toBe(true);
    for (const rel of object.relationships) expect(objectIds.has(rel.objectId)).toBe(true);
  }
  for (const event of log.events) {
    const declared = eventTypes.get(event.type);
    expect(declared).toBeDefined();
    for (const attribute of event.attributes) expect(declared?.has(attribute.name)).toBe(true);
    for (const rel of event.relationships) expect(objectIds.has(rel.objectId)).toBe(true);
  }
}

describe('toOcel2 mapping', () => {
  it('maps each stored event to one OCEL event with an ISO time and the activity name', () => {
    const log = toOcel2(FIXTURE);

    expect(log.events).toHaveLength(4);
    expect(log.events[0]).toEqual({
      id: 'a',
      type: 'app_focus',
      time: '2026-10-30T09:00:00.000Z',
      attributes: [{ name: 'windowClass', value: 'spreadsheet' }],
      relationships: [{ objectId: 'app:microsoft excel', qualifier: 'application' }],
    });
    expect(log.events[2]).toEqual({
      id: 'c',
      type: 'idle_start',
      time: '2026-10-30T09:10:00.000Z',
      attributes: [],
      relationships: [],
    });
    expect(log.events[3].type).toBe('idle_end');
  });

  it('relates a focus with a URL template to both its application and its page', () => {
    const log = toOcel2(FIXTURE);

    expect(log.events[1].relationships).toEqual([
      { objectId: 'app:google chrome', qualifier: 'application' },
      { objectId: 'url:docs.example.com/doc', qualifier: 'page' },
    ]);
  });

  it('lists each application and URL template once, typed, in a fixed order', () => {
    const log = toOcel2(FIXTURE);

    expect(log.objects).toEqual([
      { id: 'app:google chrome', type: 'App', attributes: [], relationships: [] },
      { id: 'app:microsoft excel', type: 'App', attributes: [], relationships: [] },
      { id: 'url:docs.example.com/doc', type: 'UrlTemplate', attributes: [], relationships: [] },
    ]);
  });

  it('declares every object and event type the mapping can produce', () => {
    const log = toOcel2([]);

    expect(log.objectTypes.map(type => type.name)).toEqual(['App', 'UrlTemplate']);
    expect(log.eventTypes.map(type => type.name)).toEqual(['app_focus', 'idle_start', 'idle_end', 'lock', 'unlock']);
    expect(log.eventTypes[0].attributes).toEqual([{ name: 'windowClass', type: 'string' }]);
  });

  it('returns an empty log with its declared types when there are no events', () => {
    const log = toOcel2([]);

    expect(log.events).toEqual([]);
    expect(log.objects).toEqual([]);
    expect(log.eventTypes).toHaveLength(5);
  });

  it('gives an internally consistent log for a full working week of redacted events', () => {
    const log = toOcel2(storedEvents(5));

    expect(log.events.length).toBeGreaterThan(0);
    expectConsistent(log);
    expectConsistent(toOcel2(FIXTURE));
  });
});

describe('toOcel2 privacy', () => {
  it('never exports the query string, fragment or document id of a visited URL', () => {
    const json = JSON.stringify(toOcel2(storedEvents(3)));

    expect(json).toContain('url:docs.example.com/doc');
    expect(json).not.toContain(SECRET_QUERY);
    expect(json).not.toContain('token=');
    expect(json).not.toContain('1ab2cd3ef4567890');
    expect(json).not.toContain('#top');
  });

  it('does not export an excluded app, because the redaction never stored it', () => {
    const json = JSON.stringify(toOcel2(storedEvents(3)));

    expect(json).not.toContain('1password');
  });

  it('drops keys that the redacted shape does not declare, even when they hold content', () => {
    const smuggled = {
      id: 'x1',
      ts: Date.UTC(2026, 9, 30, 9, 0),
      kind: 'focus',
      app: 'slack',
      windowClass: 'chat',
      title: 'Payroll for Jane Doe',
      url: 'https://intranet.example.com/?q=hunter2',
      typedText: 'hunter2',
    };

    const json = JSON.stringify(toOcel2([smuggled]));

    expect(json).toContain('app:slack');
    expect(json).not.toContain('Payroll');
    expect(json).not.toContain('Jane');
    expect(json).not.toContain('hunter2');
    expect(json).not.toContain('intranet');
  });

  it('refuses a URL template that carries a query string, without echoing it', () => {
    const leaky = { id: 'x2', ts: Date.UTC(2026, 9, 30), kind: 'focus', urlTemplate: `docs.example.com/doc?token=${SECRET_QUERY}` };

    let message = '';
    try {
      toOcel2([leaky]);
    } catch (error) {
      message = (error as Error).message;
    }

    expect(message).toMatch(/does not match the redacted event shape/);
    expect(message).not.toContain(SECRET_QUERY);
  });

  it('refuses a URL template with a second path segment', () => {
    const leaky = { id: 'x3', ts: Date.UTC(2026, 9, 30), kind: 'focus', urlTemplate: 'www.linkedin.com/in/jane-doe' };

    expect(() => toOcel2([leaky])).toThrow(/does not match the redacted event shape/);
  });

  it('accepts the templates templateUrl() produces, including an id placeholder and a port-free host', () => {
    const templates = ['docs.example.com/doc', 'example.com/:id', 'localhost', 'xn--bcher-kva.example/wiki'];
    const events = templates.map((urlTemplate, index) => ({
      id: `t${index}`,
      ts: Date.UTC(2026, 9, 30, 9, index),
      kind: 'focus',
      urlTemplate,
    }));

    const log = toOcel2(events);

    expect(log.objects.map(object => object.id)).toEqual(templates.map(template => `url:${template}`).sort());
  });
});

describe('toOcel2 validation', () => {
  it('refuses an event whose kind, time, window class or id does not match the shape', () => {
    const bad: unknown[] = [
      { id: 'k1', ts: Date.UTC(2026, 9, 30), kind: 'keystroke' },
      { id: 'k2', ts: 1.5, kind: 'focus' },
      { id: 'k3', ts: -1, kind: 'focus' },
      { id: 'k4', ts: Date.UTC(2026, 9, 30), kind: 'focus', windowClass: 'secret-class' },
      { ts: Date.UTC(2026, 9, 30), kind: 'focus' },
      'not an event',
      null,
    ];

    for (const input of bad) {
      expect(() => toOcel2([input])).toThrow(/does not match the redacted event shape/);
    }
  });

  it('reports the position of the refused event, not its content', () => {
    expect(() => toOcel2([...FIXTURE, { id: 'z', ts: 'soon', kind: 'focus' }])).toThrow(/Event 4 does not match/);
  });

  it('refuses two events that share an id, since OCEL ids must be unique', () => {
    const twice = [FIXTURE[0], { ...FIXTURE[1], id: FIXTURE[0].id }];

    expect(() => toOcel2(twice)).toThrow(/share an id/);
  });
});

describe('toOcel2 determinism', () => {
  it('gives the same log whatever order the events arrive in', () => {
    const forward = toOcel2(FIXTURE);
    const reversed = toOcel2([...FIXTURE].reverse());

    expect(reversed).toEqual(forward);
    expect(forward.events.map(event => event.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('survives a JSON round trip unchanged', () => {
    const log = toOcel2(storedEvents(2));

    expect(JSON.parse(JSON.stringify(log))).toEqual(log);
  });

  it('does not change the events it was given', () => {
    const before = JSON.stringify(FIXTURE);

    toOcel2(FIXTURE);

    expect(JSON.stringify(FIXTURE)).toBe(before);
  });
});
