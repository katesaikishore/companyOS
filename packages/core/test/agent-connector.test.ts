import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  TwinAgent,
  type AudioRead,
  type CaptureHitView,
  type CaptureKind,
  type ConnectorItem,
  type ConnectorSource,
  type ScreenRead,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 12);
const FOLDER = 'folder-source-0001';
const GIT = 'git-source-000002';
const INVALID_IMPORT = 'Invalid connector import: it has a field or value the twin does not accept.';
const UNKNOWN_SOURCE = 'Unknown connector source: add the source in settings before importing into it.';
const INVALID_SOURCE = 'Invalid connector source: the id is not allowed.';

function openAgent(dir: string = temps.folder('twin-connector-'), key: Buffer = randomBytes(32), now: number = NOW): TwinAgent {
  return temps.track(new TwinAgent({ dataDir: dir, dataKey: key, now: () => now }));
}

/** Adds a source to the saved list, as the desktop app does before it imports into the source. */
function addSource(agent: TwinAgent, id: string, extra: Partial<ConnectorSource> = {}): void {
  const source: ConnectorSource = { id, kind: 'folder', label: `Notes ${id}`, path: '/notes', createdAt: NOW - DAY, ...extra };
  agent.updateConfig({ connectors: [...agent.configuration.connectors, source] });
}

function item(overrides: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    source: 'folder',
    sourceId: 'note-1',
    ts: NOW - 3_600_000,
    title: 'Plan',
    text: 'The Harbourline project starts in May.',
    location: 'plans/plan.md',
    ...overrides,
  };
}

function search(agent: TwinAgent, text: string, kind?: CaptureKind): CaptureHitView[] {
  return agent.searchCapture({ text, from: 0, to: NOW + DAY, ...(kind === undefined ? {} : { kind }) });
}

function screenRead(overrides: Partial<ScreenRead> = {}): ScreenRead {
  return { ts: NOW - 60_000, app: 'Microsoft Excel', windowClass: 'spreadsheet', text: 'Quarterly budget', mediaId: null, ...overrides };
}

function audioRead(overrides: Partial<AudioRead> = {}): AudioRead {
  return { ts: NOW - 30_000, durationMs: 30_000, text: 'Harbourline call', ...overrides };
}

/** The message of an error thrown by fn, or an empty string when nothing was thrown. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('storing imported items', () => {
  it('stores an item and finds its text as a connector hit with no app', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    expect(agent.ingestConnectorItems(FOLDER, [item()])).toBe(1);
    expect(agent.connectorCount()).toBe(1);
    const hits = search(agent, 'harbourline');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'connector', app: null });
    expect(hits[0].snippet).toContain('Harbourline');
    expect(hits[0].speaker).toBeUndefined();
  });

  it('counts every item it stores, and the title is searchable as well as the text', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    const stored = agent.ingestConnectorItems(FOLDER, [
      item({ sourceId: 'a', title: 'Kickoff' }),
      item({ sourceId: 'b', title: 'Retro' }),
      item({ sourceId: 'c', title: 'Review', text: 'Nothing to see here.' }),
    ]);
    expect(stored).toBe(3);
    expect(agent.connectorCount()).toBe(3);
    expect(search(agent, 'kickoff')).toHaveLength(1);
    expect(search(agent, 'harbourline')).toHaveLength(2);
  });

  it('replaces the stored copy when the same item is imported again, so a re-import does not duplicate', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.ingestConnectorItems(FOLDER, [item({ text: 'The Harbourline project starts in May.' })]);
    agent.ingestConnectorItems(FOLDER, [item({ text: 'The Quayside project starts in June.' })]);
    agent.ingestConnectorItems(FOLDER, [item({ text: 'The Quayside project starts in June.' })]);
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'harbourline')).toEqual([]);
    expect(search(agent, 'quayside')).toHaveLength(1);
    expect(agent.searchCapture({ text: '', from: 0, to: NOW + DAY })).toHaveLength(1);
  });

  it('stores an item once when one import holds the same item id twice, and keeps the later copy', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    const stored = agent.ingestConnectorItems(FOLDER, [item({ text: 'Alpha notes' }), item({ text: 'Bravo notes' })]);
    expect(stored).toBe(1);
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'alpha')).toEqual([]);
    expect(search(agent, 'bravo')).toHaveLength(1);
  });

  it('stores the same item id under two sources as two items, one for each source', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    addSource(agent, GIT, { kind: 'git', path: '/repo' });
    agent.ingestConnectorItems(FOLDER, [item({ sourceId: 'same' })]);
    agent.ingestConnectorItems(GIT, [item({ source: 'git', sourceId: 'same' })]);
    expect(agent.connectorCount()).toBe(2);
  });

  it('stores nothing and returns zero for an empty import', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    expect(agent.ingestConnectorItems(FOLDER, [])).toBe(0);
    expect(agent.connectorCount()).toBe(0);
  });
});

describe('removing a source', () => {
  it('removes the items of one source and leaves the other sources and their search results', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    addSource(agent, GIT, { kind: 'git', path: '/repo' });
    agent.ingestConnectorItems(FOLDER, [item({ sourceId: 'a1' }), item({ sourceId: 'a2', text: 'Harbourline again.' })]);
    agent.ingestConnectorItems(GIT, [item({ source: 'git', sourceId: 'g1', title: 'Commit', text: 'Quayside change.' })]);
    expect(agent.removeConnectorItems(FOLDER)).toBe(2);
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'harbourline')).toEqual([]);
    expect(search(agent, 'quayside')).toHaveLength(1);
  });

  it("removes a source's items when the source is taken out of the saved list", () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    addSource(agent, GIT, { kind: 'git', path: '/repo' });
    agent.ingestConnectorItems(FOLDER, [item({ sourceId: 'a1' })]);
    agent.ingestConnectorItems(GIT, [item({ source: 'git', sourceId: 'g1', text: 'Quayside change.' })]);
    agent.updateConfig({ connectors: agent.configuration.connectors.filter(source => source.id === GIT) });
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'harbourline')).toEqual([]);
    expect(search(agent, 'quayside')).toHaveLength(1);
  });

  it('deletes nothing when the source holds no items', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.ingestConnectorItems(FOLDER, [item()]);
    expect(agent.removeConnectorItems('never-imported-0001')).toBe(0);
    expect(agent.connectorCount()).toBe(1);
  });

  it('refuses a removal with an id that cannot be a source, and the message names no id', () => {
    const agent = openAgent();
    expect(messageOf(() => agent.removeConnectorItems(''))).toBe(INVALID_SOURCE);
    expect(messageOf(() => agent.removeConnectorItems('x'.repeat(65)))).toBe(INVALID_SOURCE);
  });
});

describe('refused imports store nothing', () => {
  it('refuses an import into a source that is not in the saved list', () => {
    const agent = openAgent();
    expect(messageOf(() => agent.ingestConnectorItems(FOLDER, [item({ title: 'Secret title' })]))).toBe(UNKNOWN_SOURCE);
    expect(agent.connectorCount()).toBe(0);
  });

  it('refuses an item with a field the parsers do not produce, and the message names no item text', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    const extra = { ...item(), windowTitle: 'Secret window' } as ConnectorItem;
    const message = messageOf(() => agent.ingestConnectorItems(FOLDER, [item({ sourceId: 'ok' }), extra]));
    expect(message).toBe(INVALID_IMPORT);
    expect(message.includes('Secret window')).toBe(false);
    expect(agent.connectorCount()).toBe(0);
  });

  it('refuses a title over 200 characters, and a source id that is empty', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    expect(messageOf(() => agent.ingestConnectorItems(FOLDER, [item({ title: 'x'.repeat(201) })]))).toBe(INVALID_IMPORT);
    expect(messageOf(() => agent.ingestConnectorItems('', [item()]))).toBe(INVALID_IMPORT);
    expect(agent.connectorCount()).toBe(0);
  });

  it('refuses a timestamp that is not a number', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    expect(messageOf(() => agent.ingestConnectorItems(FOLDER, [item({ ts: Number.NaN })]))).toBe(INVALID_IMPORT);
    expect(agent.connectorCount()).toBe(0);
  });

  it('stores a fractional modification time as a whole millisecond', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.ingestConnectorItems(FOLDER, [item({ ts: NOW - 3_600_000 + 0.75 })]);
    expect(search(agent, 'harbourline')).toHaveLength(1);
    expect(agent.exportAll()).toMatchObject({ connectorCapture: { count: 1 } });
  });
});

describe('search by kind', () => {
  it('finds connector items beside screen text, and the kind filter separates them', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.updateConfig({ screenCaptureEnabled: true });
    agent.ingestConnectorItems(FOLDER, [item({ text: 'Harbourline review notes.' })]);
    agent.ingestScreen(screenRead({ text: 'Harbourline budget sheet' }));
    expect(search(agent, 'harbourline').map(hit => hit.kind).sort()).toEqual(['connector', 'screen']);
    expect(search(agent, 'harbourline', 'connector').map(hit => hit.kind)).toEqual(['connector']);
    expect(search(agent, 'harbourline', 'screen').map(hit => hit.kind)).toEqual(['screen']);
    expect(search(agent, 'harbourline', 'audio')).toEqual([]);
  });
});

describe('deletion rules', () => {
  it('Delete screen and audio text keeps the connector items', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.updateConfig({ screenCaptureEnabled: true, audioCaptureEnabled: true });
    agent.ingestConnectorItems(FOLDER, [item()]);
    agent.ingestScreen(screenRead({ text: 'Harbourline budget' }));
    agent.ingestAudio(audioRead());
    agent.deleteAllCapture();
    expect(agent.captureSummary()).toMatchObject({ screenCount: 0, audioCount: 0 });
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'harbourline').map(hit => hit.kind)).toEqual(['connector']);
  });

  it('Delete everything removes the connector items, because a wipe removes the whole store', () => {
    const dir = temps.folder('twin-connector-wipe-');
    const key = randomBytes(32);
    const agent = new TwinAgent({ dataDir: dir, dataKey: key, now: () => NOW });
    addSource(agent, FOLDER);
    agent.ingestConnectorItems(FOLDER, [item()]);
    agent.wipe();
    const after = openAgent(dir, key);
    expect(after.connectorCount()).toBe(0);
    expect(after.configuration.connectors).toEqual([]);
    expect(search(after, 'harbourline')).toEqual([]);
  });

  it('pruning keeps connector items past the 90-day window, and still removes old screen text', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.updateConfig({ screenCaptureEnabled: true });
    agent.ingestConnectorItems(FOLDER, [item({ ts: NOW - 200 * DAY, text: 'Harbourline archive.' })]);
    agent.ingestScreen(screenRead({ ts: NOW - 200 * DAY, text: 'Harbourline old frame' }));
    agent.prune();
    expect(agent.connectorCount()).toBe(1);
    expect(search(agent, 'harbourline').map(hit => hit.kind)).toEqual(['connector']);
  });
});

describe('redaction at ingest', () => {
  it('replaces a token in an imported title or text before anything is stored', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    const token = 'ghp_abcdefghijklmnopqrstuvwxyz0123456789';
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    agent.ingestConnectorItems(FOLDER, [item({ title: `Deploy ${token}`, text: `Use ${awsKey} for the Harbourline sync.` })]);
    const [hit] = agent.searchCapture({ text: '', from: 0, to: NOW + DAY });
    expect(hit.snippet.includes(token)).toBe(false);
    expect(hit.snippet.includes(awsKey)).toBe(false);
    expect(hit.snippet).toContain('[key]');
    expect(search(agent, 'harbourline')).toHaveLength(1);
  });

  it('replaces a card-like number in imported text', () => {
    const agent = openAgent();
    addSource(agent, FOLDER);
    agent.ingestConnectorItems(FOLDER, [item({ text: 'Card 4111 1111 1111 1111 for the Harbourline trip.' })]);
    const [hit] = agent.searchCapture({ text: '', from: 0, to: NOW + DAY });
    expect(hit.snippet).not.toContain('4111 1111 1111 1111');
    expect(hit.snippet).toContain('[card number]');
  });
});

describe('the export', () => {
  it('holds counts and dates for connector items, and no text, title, location, label or path', () => {
    const agent = openAgent();
    addSource(agent, FOLDER, { label: 'Label canary 4460', path: '/home/person/path-canary-2254' });
    agent.ingestConnectorItems(FOLDER, [
      item({ sourceId: 'n1', ts: NOW - 2 * DAY, title: 'Title canary 0932', text: 'Text canary 6d2f81', location: 'loc-canary-8817.md' }),
      item({ sourceId: 'n2', ts: NOW - DAY, title: 'Second', text: 'Second text' }),
    ]);
    const exported = agent.exportAll() as {
      connectorCapture: unknown;
      config: { connectors: Array<Record<string, unknown>> };
    };
    expect(exported.connectorCapture).toEqual({
      count: 2,
      oldest: new Date(NOW - 2 * DAY).toISOString(),
      newest: new Date(NOW - DAY).toISOString(),
    });
    const text = JSON.stringify(agent.exportAll());
    for (const secret of ['Title canary', 'Text canary', 'loc-canary', 'Label canary', 'path-canary', 'Second text']) {
      expect(text.includes(secret)).toBe(false);
    }
    expect(exported.config.connectors).toEqual([
      { id: FOLDER, kind: 'folder', label: '[typed name not exported]', path: '[typed name not exported]', createdAt: NOW - DAY },
    ]);
  });

  it('leaves out the path key of a cloud source, which has no path', () => {
    const agent = openAgent();
    addSource(agent, 'cloud-source-000001', { kind: 'github', path: undefined, label: 'Team repos' });
    const exported = agent.exportAll() as { config: { connectors: Array<Record<string, unknown>> } };
    expect(exported.config.connectors[0]).toMatchObject({ kind: 'github', label: '[typed name not exported]' });
    expect('path' in exported.config.connectors[0]).toBe(false);
  });

  it('reports zero connector items, with no dates, when none are stored', () => {
    const agent = openAgent();
    expect(agent.exportAll()).toMatchObject({ connectorCapture: { count: 0, oldest: null, newest: null } });
  });
});

describe('ledger and console', () => {
  it('keeps a connector call in the ledger with its purpose, host, path and byte count', () => {
    const agent = openAgent();
    agent.recordNetworkCall({ ts: NOW, purpose: 'connector', host: 'api.example.com', path: '/v1/events', bytes: 2048, outcome: 'ok' });
    expect(agent.networkLedger()).toEqual([
      { ts: NOW, purpose: 'connector', host: 'api.example.com', path: '/v1/events', bytes: 2048, outcome: 'ok' },
    ]);
  });

  it('prints nothing to the console while items are imported, searched, removed and exported', () => {
    const spies = ['log', 'info', 'warn', 'error', 'debug'].map(method => vi.spyOn(console, method as 'log'));
    try {
      const agent = openAgent();
      addSource(agent, FOLDER);
      agent.ingestConnectorItems(FOLDER, [item()]);
      search(agent, 'harbourline');
      expect(messageOf(() => agent.ingestConnectorItems(GIT, [item()]))).toBe(UNKNOWN_SOURCE);
      agent.exportAll();
      agent.removeConnectorItems(FOLDER);
      for (const spy of spies) expect(spy).not.toHaveBeenCalled();
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });
});
