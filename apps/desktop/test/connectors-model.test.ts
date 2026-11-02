import {
  CONNECTOR_LABEL_MAX as ENGINE_LABEL_MAX,
  CONNECTOR_PATH_MAX as ENGINE_PATH_MAX,
  CONNECTOR_SOURCE_KINDS,
  DEFAULT_CONFIG,
  MAX_CONNECTORS,
  mergeConfigPatch,
  type TwinConfig,
} from '@companyos/twin-core';
import { describe, expect, it } from 'vitest';
import {
  CONNECTOR_ADD_LABELS,
  CONNECTOR_LIMITS,
  CONNECTOR_NEVER_COPY,
  CONNECTOR_READ_COPY,
  CONNECTORS_NOTE,
  LOCAL_CONNECTOR_KINDS,
  connectorStatusLine,
  connectorsFull,
} from '../src/renderer/connectors-model';
import {
  CONNECTOR_LABEL_MAX,
  CONNECTOR_PATH_MAX,
  CONNECTOR_SOURCE_MAX,
  LOCAL_CONNECTOR_KINDS as MAIN_LOCAL_KINDS,
} from '../src/main/connectors-validate';

/** Whether the engine's config schema accepts a list of sources. */
function engineAccepts(connectors: unknown[]): boolean {
  try {
    mergeConfigPatch(DEFAULT_CONFIG as TwinConfig, { connectors } as Partial<TwinConfig>);
    return true;
  } catch {
    return false;
  }
}

function source(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { id: 'renderer-copy-0001', kind: 'folder', label: 'Notes', path: '/notes', createdAt: 1, ...overrides };
}

describe('the renderer copy of the connector limits, against the engine', () => {
  it('has the engine\'s maximum number of sources', () => {
    expect(CONNECTOR_LIMITS.maxSources).toBe(MAX_CONNECTORS);
    const full = Array.from({ length: CONNECTOR_LIMITS.maxSources }, (_, index) =>
      source({ id: `renderer-copy-${String(index).padStart(4, '0')}` }),
    );
    expect(engineAccepts(full)).toBe(true);
    expect(engineAccepts([...full, source({ id: 'renderer-copy-9999' })])).toBe(false);
    expect(connectorsFull(CONNECTOR_LIMITS.maxSources - 1)).toBe(false);
    expect(connectorsFull(CONNECTOR_LIMITS.maxSources)).toBe(true);
  });

  it('has the engine\'s label and path lengths, and accepts exactly those lengths', () => {
    expect(CONNECTOR_LIMITS.labelMax).toBe(ENGINE_LABEL_MAX);
    expect(CONNECTOR_LIMITS.pathMax).toBe(ENGINE_PATH_MAX);
    expect(engineAccepts([source({ label: 'x'.repeat(CONNECTOR_LIMITS.labelMax) })])).toBe(true);
    expect(engineAccepts([source({ label: 'x'.repeat(CONNECTOR_LIMITS.labelMax + 1) })])).toBe(false);
    expect(engineAccepts([source({ path: `/${'p'.repeat(CONNECTOR_LIMITS.pathMax - 1)}` })])).toBe(true);
    expect(engineAccepts([source({ path: `/${'p'.repeat(CONNECTOR_LIMITS.pathMax)}` })])).toBe(false);
  });

  it('has the engine\'s id lengths, which are 16 to 64 characters', () => {
    expect(engineAccepts([source({ id: 'i'.repeat(CONNECTOR_LIMITS.idMin) })])).toBe(true);
    expect(engineAccepts([source({ id: 'i'.repeat(CONNECTOR_LIMITS.idMin - 1) })])).toBe(false);
    expect(engineAccepts([source({ id: 'i'.repeat(CONNECTOR_LIMITS.idMax) })])).toBe(true);
    expect(engineAccepts([source({ id: 'i'.repeat(CONNECTOR_LIMITS.idMax + 1) })])).toBe(false);
  });

  it('lists the local kinds the engine lists first, in the same order', () => {
    expect([...LOCAL_CONNECTOR_KINDS]).toEqual(CONNECTOR_SOURCE_KINDS.slice(0, 4));
    for (const kind of LOCAL_CONNECTOR_KINDS) expect(engineAccepts([source({ kind })])).toBe(true);
  });

  it('refuses a path on a cloud source, as the engine does', () => {
    expect(engineAccepts([source({ kind: 'google-calendar', path: '/notes' })])).toBe(false);
    expect(engineAccepts([source({ kind: 'github', path: undefined })])).toBe(true);
  });

  it('matches the desktop main process copies too', () => {
    expect(CONNECTOR_SOURCE_MAX).toBe(CONNECTOR_LIMITS.maxSources);
    expect(CONNECTOR_LABEL_MAX).toBe(CONNECTOR_LIMITS.labelMax);
    expect(CONNECTOR_PATH_MAX).toBe(CONNECTOR_LIMITS.pathMax);
    expect([...MAIN_LOCAL_KINDS]).toEqual([...LOCAL_CONNECTOR_KINDS]);
  });
});

describe('the Settings copy', () => {
  it('says the files stay on this device, are read only, and that nothing is written back', () => {
    expect(CONNECTOR_NEVER_COPY).toContain('stay on this device');
    expect(CONNECTOR_NEVER_COPY).toContain('read only');
    expect(CONNECTOR_NEVER_COPY).toContain('nothing is written back');
    expect(CONNECTOR_NEVER_COPY).toContain('Nothing from a connector is sent over the network');
  });

  it('says what is read, for each kind, and where the text is kept', () => {
    for (const word of ['Folder', 'Git repository', 'Calendar file', 'Mail archive', 'Senders and attachments are not read']) {
      expect(CONNECTOR_READ_COPY).toContain(word);
    }
    expect(CONNECTOR_READ_COPY).toContain('180 days ago to 365 days ahead');
    expect(CONNECTORS_NOTE).toContain('on this device');
  });

  it('has a button label for each local kind', () => {
    expect(CONNECTOR_ADD_LABELS).toEqual({
      folder: 'Add folder',
      git: 'Add Git repository',
      calendar: 'Add calendar file',
      mail: 'Add mail archive',
    });
  });
});

describe('connectorStatusLine', () => {
  const NOW = Date.UTC(2026, 5, 15, 12);

  it('says a source has not been read yet', () => {
    expect(connectorStatusLine('folder', undefined, undefined, NOW)).toBe('Folder · Not read yet');
  });

  it('gives the last read time, and the item count when this session knows it', () => {
    const withoutCount = connectorStatusLine('mail', NOW - 3_600_000, undefined, NOW);
    expect(withoutCount.startsWith('Mail archive · Last read ')).toBe(true);
    expect(withoutCount).not.toContain('item');
    expect(connectorStatusLine('mail', NOW, 1, NOW).endsWith('· 1 item')).toBe(true);
    expect(connectorStatusLine('mail', NOW, 2, NOW).endsWith('· 2 items')).toBe(true);
  });
});
