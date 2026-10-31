import { z } from 'zod';
import { SIGNAL_KINDS, WINDOW_CLASSES, type SignalKind } from './types';

/**
 * OCEL 2.0 export of the twin's events (plan decision D8; storage in section 6.2, event shape in section 5.4).
 *
 * Only the redacted event shape is exported. Each stored event is parsed against that shape, and the output is built
 * from the parsed fields alone, so a key the shape does not declare never reaches the file. An event that does not
 * match is refused, and the error names no content.
 *
 * Mapping, following the desktop object types in docs/research/understanding-ml.md (section 1):
 * - Each signal kind is one OCEL event type. A focus is `app_focus`; the other kinds keep their names.
 * - The application is an object of type App. The URL template is an object of type UrlTemplate.
 * - An app_focus event relates to its App with the qualifier `application`, and to its URL template with `page`.
 * - windowClass is an attribute of app_focus events.
 */

/** The largest time a JavaScript Date can hold. Anything larger cannot be written as an ISO time. */
const MAX_EPOCH_MS = 8.64e15;

/**
 * A URL template as templateUrl() produces it: a host, then at most one plain word or :id. A query, a fragment or a
 * further path segment does not match, so such a value is refused rather than exported.
 */
const URL_TEMPLATE = /^[a-z0-9.\-\[\]:]{1,253}(?:\/(?::id|[a-z]{1,12}))?$/;

const StoredEventSchema = z.object({
  id: z.string().min(1).max(200),
  ts: z.number().int().nonnegative().max(MAX_EPOCH_MS),
  kind: z.enum(SIGNAL_KINDS),
  app: z.string().min(1).max(200).optional(),
  windowClass: z.enum(WINDOW_CLASSES).optional(),
  urlTemplate: z.string().regex(URL_TEMPLATE).optional(),
});

export type OcelValueType = 'string' | 'integer' | 'float' | 'boolean' | 'timestamp';

export interface OcelAttributeDeclaration {
  name: string;
  type: OcelValueType;
}

export interface OcelTypeDeclaration {
  name: string;
  attributes: OcelAttributeDeclaration[];
}

export interface OcelRelationship {
  objectId: string;
  qualifier: string;
}

export interface OcelEvent {
  id: string;
  type: string;
  /** ISO 8601 in UTC. */
  time: string;
  attributes: Array<{ name: string; value: string }>;
  relationships: OcelRelationship[];
}

export interface OcelObject {
  id: string;
  type: string;
  attributes: Array<{ name: string; time: string; value: string }>;
  relationships: OcelRelationship[];
}

/** An OCEL 2.0 log in its JSON object form. */
export interface Ocel2Log {
  objectTypes: OcelTypeDeclaration[];
  eventTypes: OcelTypeDeclaration[];
  objects: OcelObject[];
  events: OcelEvent[];
}

/** The OCEL event type for each signal kind. */
const ACTIVITY: Record<SignalKind, string> = {
  focus: 'app_focus',
  idle_start: 'idle_start',
  idle_end: 'idle_end',
  lock: 'lock',
  unlock: 'unlock',
};

const APP_TYPE = 'App';
const URL_TYPE = 'UrlTemplate';

function eventTypeDeclarations(): OcelTypeDeclaration[] {
  return (Object.keys(ACTIVITY) as SignalKind[]).map<OcelTypeDeclaration>(kind => ({
    name: ACTIVITY[kind],
    attributes: kind === 'focus' ? [{ name: 'windowClass', type: 'string' }] : [],
  }));
}

function objectTypeDeclarations(): OcelTypeDeclaration[] {
  return [
    { name: APP_TYPE, attributes: [] },
    { name: URL_TYPE, attributes: [] },
  ];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Converts stored twin events into an OCEL 2.0 log. Events are ordered by time, then id, and objects by type, then id,
 * so the same events always give the same log. The declared types are always the full set the mapping can produce.
 *
 * Throws if an event does not match the redacted shape or if two events share an id. The error text names no content.
 */
export function toOcel2(events: readonly unknown[]): Ocel2Log {
  const parsed = events.map((input, index) => {
    const result = StoredEventSchema.safeParse(input);
    if (!result.success) {
      throw new Error(`Event ${index} does not match the redacted event shape, so it was not exported.`);
    }
    return result.data;
  });

  const ids = new Set<string>();
  for (const event of parsed) {
    if (ids.has(event.id)) throw new Error('Two events share an id, so the log would not be valid OCEL 2.0.');
    ids.add(event.id);
  }

  const objects = new Map<string, OcelObject>();
  const reference = (objectId: string, type: string, qualifier: string): OcelRelationship => {
    if (!objects.has(objectId)) objects.set(objectId, { id: objectId, type, attributes: [], relationships: [] });
    return { objectId, qualifier };
  };

  const ordered = [...parsed].sort((a, b) => a.ts - b.ts || compareText(a.id, b.id));
  const ocelEvents: OcelEvent[] = ordered.map(event => {
    const relationships: OcelRelationship[] = [];
    if (event.app !== undefined) relationships.push(reference(`app:${event.app}`, APP_TYPE, 'application'));
    if (event.urlTemplate !== undefined) {
      relationships.push(reference(`url:${event.urlTemplate}`, URL_TYPE, 'page'));
    }
    return {
      id: event.id,
      type: ACTIVITY[event.kind],
      time: new Date(event.ts).toISOString(),
      attributes: event.windowClass === undefined ? [] : [{ name: 'windowClass', value: event.windowClass }],
      relationships,
    };
  });

  const objectList = [...objects.values()].sort((a, b) => compareText(a.type, b.type) || compareText(a.id, b.id));

  return {
    objectTypes: objectTypeDeclarations(),
    eventTypes: eventTypeDeclarations(),
    objects: objectList,
    events: ocelEvents,
  };
}
