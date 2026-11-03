import { formatWhen, plural } from './format.js';

/**
 * The limits and the copy of the Connectors section. The renderer cannot import the engine's values, so the limits are a
 * copy of the source schema in packages/core/src/types.ts, and test/connectors-model.test.ts fails if the two differ.
 */
export const CONNECTOR_LIMITS = {
  maxSources: 20,
  labelMax: 60,
  pathMax: 1000,
  idMin: 16,
  idMax: 64,
} as const;

/** The kinds that read a file or folder on this device. The cloud kinds have their own section. */
export const LOCAL_CONNECTOR_KINDS = ['folder', 'git', 'calendar', 'mail'] as const;
export type LocalConnectorKind = (typeof LOCAL_CONNECTOR_KINDS)[number];

const CONNECTOR_KIND_LABELS: Record<LocalConnectorKind, string> = {
  folder: 'Folder',
  git: 'Git repository',
  calendar: 'Calendar file',
  mail: 'Mail archive',
};

export const CONNECTOR_ADD_LABELS: Record<LocalConnectorKind, string> = {
  folder: 'Add folder',
  git: 'Add Git repository',
  calendar: 'Add calendar file',
  mail: 'Add mail archive',
};

/** What the section says first: where the text is read, how often, and that the files stay put. */
export const CONNECTORS_NOTE =
  'A connector reads a folder, Git repository, calendar file or mail archive that you choose, and keeps its text on this device. It reads once when you add it, again when you choose Import now, and about every six hours while the app runs. Those automatic reads wait while capture is paused, the screen is locked, or you are away. Import now always reads.';

export const CONNECTOR_READ_COPY =
  'Folder: Markdown, plain text and HTML files (.md, .markdown, .txt, .html, .htm) up to 1 MB, skipping hidden files and folders, up to 5,000 files in path order. Git repository: each commit\'s date, subject and the names of the files it changed, never the changes, up to 16 MB of Git output. Calendar file (.ics): events from 180 days ago to 365 days ahead, with each event\'s title, description and location. Mail archive (.mbox): up to 5,000 messages, with the date, subject and plain text of each. Senders and attachments are not read.';

export const CONNECTOR_WHERE_COPY =
  'The text is stored in the same encrypted store as your other history, after the same redaction screen text gets. When the local API is on, its search can return these items too.';

export const CONNECTOR_NEVER_COPY =
  'Nothing from a connector is sent over the network, and no connector opens a connection. The files stay on this device and are read only: nothing is written back to them. Export holds only counts and dates for these items, and replaces their labels and paths with a placeholder.';

export const CONNECTOR_DELETE_COPY =
  'Delete screen and audio text does not remove these items, because you chose to import them. Delete everything does. Removing a source removes its items.';

/**
 * One line under a source's name: its kind, when it was last read, and how many items that read stored when this session
 * knows the count. A source that has not been read yet says so.
 */
export function connectorStatusLine(
  kind: LocalConnectorKind,
  lastImportedAt: number | undefined,
  count: number | undefined,
  now: number,
): string {
  const kindLabel = CONNECTOR_KIND_LABELS[kind];
  if (lastImportedAt === undefined) return `${kindLabel} · Not read yet`;
  const read = `Last read ${formatWhen(lastImportedAt, now)}`;
  return count === undefined ? `${kindLabel} · ${read}` : `${kindLabel} · ${read} · ${plural(count, 'item')}`;
}

/** Whether the list is at its limit, so no source can be added. */
export function connectorsFull(sourceCount: number): boolean {
  return sourceCount >= CONNECTOR_LIMITS.maxSources;
}
