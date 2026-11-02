import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_KINDS,
  ConnectorSourceSchema,
  ConnectorSourcesSchema,
  DEFAULT_CONFIG,
  MAX_CONNECTORS,
  TwinAgent,
  TwinConfigSchema,
  type ConnectorSource,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();
const NOW = Date.UTC(2026, 9, 31, 12);
const ID = 'folder-source-0001';

function source(overrides: Partial<ConnectorSource> = {}): ConnectorSource {
  return { id: ID, kind: 'folder', label: 'Notes', path: '/notes', createdAt: NOW, ...overrides };
}

describe('the connector list in the config', () => {
  it('is empty by default, so nothing is imported until the person adds a source', () => {
    expect(DEFAULT_CONFIG.connectors).toEqual([]);
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-connector-config-'), dataKey: randomBytes(32), now: () => NOW }));
    expect(agent.configuration.connectors).toEqual([]);
  });

  it('reads as empty for a config saved before connectors existed', () => {
    const { connectors: _omitted, ...saved } = DEFAULT_CONFIG;
    expect(TwinConfigSchema.parse(saved).connectors).toEqual([]);
  });

  it('keeps a source across a restart of the agent', () => {
    const dir = temps.folder('twin-connector-restart-');
    const key = randomBytes(32);
    const first = new TwinAgent({ dataDir: dir, dataKey: key, now: () => NOW });
    first.updateConfig({ connectors: [source()] });
    first.close();
    const second = temps.track(new TwinAgent({ dataDir: dir, dataKey: key, now: () => NOW }));
    expect(second.configuration.connectors).toEqual([source()]);
  });

  it('lists the connector kind among the capture kinds, so search can ask for it', () => {
    expect(CAPTURE_KINDS).toContain('connector');
  });
});

describe('one source', () => {
  it('accepts a local source with a path, and a cloud source with none', () => {
    expect(ConnectorSourceSchema.safeParse(source()).success).toBe(true);
    expect(ConnectorSourceSchema.safeParse({ id: 'cloud-source-000001', kind: 'github', label: 'Repos', createdAt: NOW }).success).toBe(true);
    expect(ConnectorSourceSchema.safeParse({ id: 'cloud-source-000002', kind: 'google-calendar', label: 'Work', createdAt: NOW }).success).toBe(true);
  });

  it('refuses a path on a cloud source, since only a local source reads a file', () => {
    expect(ConnectorSourceSchema.safeParse({ ...source(), kind: 'github' }).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse({ ...source(), kind: 'google-calendar' }).success).toBe(false);
  });

  it('refuses an id that is not 16 to 64 characters', () => {
    expect(ConnectorSourceSchema.safeParse(source({ id: 'short-0001' })).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse(source({ id: 'x'.repeat(65) })).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse(source({ id: 'x'.repeat(16) })).success).toBe(true);
    expect(ConnectorSourceSchema.safeParse(source({ id: 'x'.repeat(64) })).success).toBe(true);
  });

  it('refuses a label that is empty, longer than 60 characters, or holds a control character', () => {
    expect(ConnectorSourceSchema.safeParse(source({ label: '   ' })).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse(source({ label: 'x'.repeat(61) })).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse(source({ label: 'x'.repeat(60) })).success).toBe(true);
    expect(ConnectorSourceSchema.safeParse(source({ label: 'Notes\nSecret' })).success).toBe(false);
  });

  it('refuses a path longer than 1000 characters, or one with a control character', () => {
    expect(ConnectorSourceSchema.safeParse(source({ path: `/${'a'.repeat(1000)}` })).success).toBe(false);
    expect(ConnectorSourceSchema.safeParse(source({ path: '/notes/\u0000' })).success).toBe(false);
  });

  it('refuses a field the schema does not name, so a source cannot carry a token', () => {
    expect(ConnectorSourceSchema.safeParse({ ...source(), token: 'secret' }).success).toBe(false);
  });

  it('refuses an update whose label holds a control character, and the error names no label', () => {
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-connector-label-'), dataKey: randomBytes(32), now: () => NOW }));
    let message = '';
    try {
      agent.updateConfig({ connectors: [source({ label: 'Notes\nCANARY_LABEL_0A1B2C' })] });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).not.toBe('');
    expect(message.includes('CANARY_LABEL_0A1B2C')).toBe(false);
    expect(agent.configuration.connectors).toEqual([]);
  });
});

describe('the list of sources', () => {
  it('holds at most 20 sources', () => {
    const many = Array.from({ length: MAX_CONNECTORS }, (_, index) => source({ id: `folder-source-${String(index).padStart(4, '0')}` }));
    expect(MAX_CONNECTORS).toBe(20);
    expect(ConnectorSourcesSchema.safeParse(many).success).toBe(true);
    expect(ConnectorSourcesSchema.safeParse([...many, source({ id: 'folder-source-9999' })]).success).toBe(false);
  });

  it('gives each source its own id', () => {
    expect(ConnectorSourcesSchema.safeParse([source(), source({ label: 'Other' })]).success).toBe(false);
  });

  it('refuses a 21st source in an update, and saves nothing', () => {
    const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-connector-cap-'), dataKey: randomBytes(32), now: () => NOW }));
    const many = Array.from({ length: MAX_CONNECTORS + 1 }, (_, index) => source({ id: `folder-source-${String(index).padStart(4, '0')}` }));
    expect(() => agent.updateConfig({ connectors: many })).toThrow();
    expect(agent.configuration.connectors).toEqual([]);
  });
});
