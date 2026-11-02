import { TwinAgent, type ConnectorItem } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { findLeaks, type Surface } from './canaries';
import { ConsoleCapture, diskSurfaces, errorText } from './surfaces';

// Imported connector items are the person's own files, mail and calendar entries, stored encrypted. They reach no output
// surface except the search they are found by, and the decrypted index, which holds them by design.
//
// Each text canary has spaces between its words, so the key-like redaction (which matches a run of 20 characters or more
// with no space) leaves it alone and the check sees the text that would otherwise be stored. The token canary is shaped like
// a GitHub token, so it must be replaced before anything is written.

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 12);
const SOURCE_ID = 'folder-source-0001';
const OTHER_ID = 'git-source-000002';
const UNKNOWN_ID = 'unknown-source-0003';

const CONNECTOR = {
  itemText: 'CANARY CONNECTOR TEXT 6D2F81',
  itemTitle: 'CANARY CONNECTOR TITLE 0B7E45',
  itemLocation: 'CANARY CONNECTOR LOCATION C94A13',
  removedText: 'CANARY CONNECTOR REMOVED 5E09AB',
  sourceLabel: 'CANARY_CONNECTOR_LABEL_3F18D6',
  sourcePath: 'CANARY_CONNECTOR_PATH_E270B9',
  refusedField: 'CANARY_CONNECTOR_REFUSED_7A5C02',
  token: 'ghp_CANARYTOKEN9B3D1F0A2C4E6G8H0J',
} as const;

/** Every value the suite plants, for the checks that look for any of them. */
const PLANTED: Readonly<Record<string, string>> = { ...CONNECTOR };

interface ConnectorRun {
  root: string;
  surfaces: Surface[];
  console: string;
  errors: string[];
  exported: string;
}

let run: ConnectorRun;

function item(sourceId: string, overrides: Partial<ConnectorItem> = {}): ConnectorItem {
  return {
    source: 'folder',
    sourceId,
    ts: NOW - 3_600_000,
    title: CONNECTOR.itemTitle,
    text: `Plan ${CONNECTOR.itemText} with ${CONNECTOR.token}.`,
    location: CONNECTOR.itemLocation,
    ...overrides,
  };
}

/** Runs a call that is expected to be refused, and keeps only the error it throws, as the app would show it. */
function refusal(errors: string[], call: () => unknown): void {
  try {
    call();
  } catch (error) {
    errors.push(errorText(error));
  }
}

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), 'twin-privacy-connector-'));
  try {
    run = scenario(root);
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}, 60_000);

afterAll(() => {
  if (run) rmSync(run.root, { recursive: true, force: true });
});

/** Plants the connector values, runs the surfaces the person sees, and reads every surface back. */
function scenario(root: string): ConnectorRun {
  const storeDir = join(root, 'twin');
  const key = randomBytes(32);
  const errors: string[] = [];
  const capture = new ConsoleCapture();
  let surfaces: Surface[] = [];
  let exported = '';
  try {
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => NOW });
    try {
      agent.updateConfig({
        connectors: [
          { id: SOURCE_ID, kind: 'folder', label: CONNECTOR.sourceLabel, path: `/home/person/${CONNECTOR.sourcePath}`, createdAt: NOW - DAY },
        ],
      });
      agent.ingestConnectorItems(SOURCE_ID, [item('note-1')]);
      agent.searchCapture({ text: 'plan', kind: 'connector', from: 0, to: NOW + DAY });

      // Refused: an unknown source, an item with a field the parsers do not produce, and a label with a control character.
      refusal(errors, () => agent.ingestConnectorItems(UNKNOWN_ID, [item('note-2')]));
      refusal(errors, () => agent.ingestConnectorItems(SOURCE_ID, [{ ...item('note-3'), windowTitle: CONNECTOR.refusedField } as ConnectorItem]));
      refusal(errors, () =>
        agent.updateConfig({
          connectors: [
            { id: SOURCE_ID, kind: 'folder', label: `Bad\n${CONNECTOR.refusedField}`, path: '/notes', createdAt: NOW - DAY },
          ],
        }),
      );

      // A second source is imported, then removed. Its text must be gone from the store afterwards.
      agent.updateConfig({
        connectors: [
          ...agent.configuration.connectors,
          { id: OTHER_ID, kind: 'git', label: 'Repository', path: '/repo', createdAt: NOW - DAY },
        ],
      });
      agent.ingestConnectorItems(OTHER_ID, [item('commit-1', { source: 'git', text: CONNECTOR.removedText })]);
      agent.removeConnectorItems(OTHER_ID);

      exported = JSON.stringify(agent.exportAll(), null, 2);
    } finally {
      // The store is closed before its files are read, so the reads do not share a handle with the agent.
      agent.close();
    }
    surfaces = diskSurfaces(root, storeDir, key);
  } finally {
    capture.restore();
  }
  return { root, surfaces, console: capture.text(), errors, exported };
}

function surfacesNamed(select: (name: string) => boolean): Surface[] {
  const selected = run.surfaces.filter(surface => select(surface.name));
  expect(selected.length, 'no surface matched, so nothing was checked').toBeGreaterThan(0);
  return selected;
}

describe('imported connector text reaches no output surface', () => {
  it('the scanner finds each planted value on a surface that holds it, so the checks below can fail', () => {
    for (const [name, value] of Object.entries(PLANTED)) {
      const found = findLeaks([{ name: 'probe', text: `before ${value} after` }], { [name]: value });
      expect(found.length, `the scanner missed ${name}`).toBeGreaterThan(0);
    }
  });

  it('the console, stdout and stderr hold no connector text', () => {
    expect(findLeaks([{ name: 'console', text: run.console }], PLANTED)).toEqual([]);
  });

  it('the export holds the count and dates, and no text, title, location, label or path', () => {
    expect(run.exported).toContain('"connectorCapture"');
    expect(findLeaks([{ name: 'export', text: run.exported }], PLANTED)).toEqual([]);
  });

  it('the errors from refused imports and a refused settings change name no connector value', () => {
    expect(run.errors).toHaveLength(3);
    expect(run.errors.join('\n')).toContain('Unknown connector source: add the source in settings before importing into it.');
    expect(findLeaks([{ name: 'errors', text: run.errors.join('\n') }], PLANTED)).toEqual([]);
  });

  it('the raw store and the other files under the data folder hold no connector value', () => {
    const selected = surfacesNamed(name => name.startsWith('store:raw:') || name.startsWith('disk:'));
    expect(findLeaks(selected, PLANTED)).toEqual([]);
  });
});

describe('the encrypted store holds the text, and redaction and removal act on it', () => {
  it('the decrypted index holds the imported text, so the checks above are not an empty pass', () => {
    const index = run.surfaces.find(surface => surface.name === 'store:decrypted:capture')?.text ?? '';
    expect(index).toContain(CONNECTOR.itemText);
    expect(index).toContain(CONNECTOR.itemTitle);
  });

  it('a token in an imported item is replaced before it is stored, on every decrypted surface', () => {
    const selected = surfacesNamed(name => name === 'store:decrypted:capture' || name === 'store:decrypted:connectorText');
    expect(findLeaks(selected, { token: CONNECTOR.token })).toEqual([]);
    const index = run.surfaces.find(surface => surface.name === 'store:decrypted:capture')?.text ?? '';
    expect(index).toContain('[key]');
  });

  it('a refused item is not stored', () => {
    const selected = surfacesNamed(name => name === 'store:decrypted:capture' || name === 'store:decrypted:connectorText');
    expect(findLeaks(selected, { refusedField: CONNECTOR.refusedField })).toEqual([]);
  });

  it('removing a source removes its text from the store', () => {
    const selected = surfacesNamed(name => name === 'store:decrypted:capture' || name === 'store:decrypted:connectorText');
    expect(findLeaks(selected, { removedText: CONNECTOR.removedText })).toEqual([]);
  });
});
