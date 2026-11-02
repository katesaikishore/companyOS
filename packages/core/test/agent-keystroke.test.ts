import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, TwinAgent, type KeystrokeRead } from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 12);
const TYPED_CANARY = 'typed-canary-seven';
const CARD = '4111 1111 1111 1111';
const KEY = 'AKIAIOSFODNN7EXAMPLE';

function openAgent(now: number = NOW): TwinAgent {
  const dir = temps.folder('twin-keystroke-agent-');
  return temps.track(new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => now }));
}

/** An agent with typed text switched on, as after the person turns it on. */
function enabled(agent: TwinAgent = openAgent()): TwinAgent {
  agent.updateConfig({ keystrokeCaptureEnabled: true });
  return agent;
}

function piece(overrides: Partial<KeystrokeRead> = {}): KeystrokeRead {
  return { ts: NOW - 60_000, app: 'Microsoft Word', windowClass: 'document', text: `Quarterly ${TYPED_CANARY}`, ...overrides };
}

function search(agent: TwinAgent, text: string) {
  return agent.searchCapture({ text, from: NOW - DAY, to: NOW + DAY });
}

describe('typed text is off until the person turns it on', () => {
  it('defaults the setting to off', () => {
    expect(DEFAULT_CONFIG.keystrokeCaptureEnabled).toBe(false);
  });

  it('refuses a piece while the setting is off, and stores nothing', () => {
    const agent = openAgent();
    expect(agent.ingestKeystrokes(piece())).toBe(false);
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
    expect(search(agent, TYPED_CANARY)).toEqual([]);
  });
});

describe('a finished piece of typed text is stored as its own kind', () => {
  it('stores it, counts it, and finds it by a word in it', () => {
    const agent = enabled();
    expect(agent.ingestKeystrokes(piece())).toBe(true);
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 1, screenCount: 0, audioCount: 0 });
    const hits = search(agent, 'quarterly');
    expect(hits).toHaveLength(1);
    // App names are stored in the normalised form the screen path uses, so the match is on that form.
    expect(hits[0]).toMatchObject({ kind: 'keystroke', app: 'microsoft word' });
  });

  it('can be filtered to typed text only', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece());
    expect(agent.searchCapture({ text: 'quarterly', kind: 'keystroke', from: NOW - DAY, to: NOW + DAY })).toHaveLength(1);
    expect(agent.searchCapture({ text: 'quarterly', kind: 'screen', from: NOW - DAY, to: NOW + DAY })).toEqual([]);
  });

  it('redacts a card-like number and a key-like token before it is stored or searched', () => {
    const agent = enabled();
    expect(agent.ingestKeystrokes(piece({ text: `card ${CARD} key ${KEY} ${TYPED_CANARY}` }))).toBe(true);
    expect(search(agent, '4111')).toEqual([]);
    expect(search(agent, 'AKIAIOSFODNN7EXAMPLE')).toEqual([]);
    const [hit] = search(agent, 'card');
    expect(hit.snippet).toContain('[card number]');
    expect(hit.snippet).toContain('[key]');
    expect(hit.snippet).not.toContain('4111');
  });

  it('stores no typed text in the record body, only the time and the window kind', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece());
    const store = (agent as unknown as { store: { readAll: (collection: string) => unknown[] } }).store;
    expect(store.readAll('keystrokeText')).toEqual([{ ts: NOW - 60_000, windowClass: 'document' }]);
  });
});

describe('refused pieces are dropped without a trace', () => {
  it.each<[string, Partial<KeystrokeRead>]>([
    ['a browser window', { app: 'Google Chrome', windowClass: 'browser' }],
    ['a browser by app name', { app: 'Firefox', windowClass: 'document' }],
    ['an excluded app', { app: '1Password', windowClass: 'other' }],
    ['a window kind that is excluded', { windowClass: 'chat' }],
    ['text that is only spaces', { text: '   ' }],
  ])('drops a piece with %s', (_name, change) => {
    const agent = enabled();
    agent.updateConfig({ excludedWindowClasses: ['chat'] });
    expect(agent.ingestKeystrokes(piece(change))).toBe(false);
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
  });

  it('refuses a piece with no app name, since it cannot be checked against the exclusions', () => {
    const agent = enabled();
    expect(() => agent.ingestKeystrokes(piece({ app: '' }))).toThrow(
      'Invalid capture: it has a field or value the twin does not accept.',
    );
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
  });

  it('refuses a field it does not know, with a fixed sentence that does not echo the text', () => {
    const agent = enabled();
    const bad = { ...piece(), password: TYPED_CANARY } as unknown as KeystrokeRead;
    let message = '';
    try {
      agent.ingestKeystrokes(bad);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toBe('Invalid capture: it has a field or value the twin does not accept.');
    expect(message).not.toContain(TYPED_CANARY);
  });
});

describe('typed text follows the same retention and deletion as the rest of the capture', () => {
  it('is removed by Delete screen, audio and typed text', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece());
    expect(agent.deleteAllCapture()).toEqual([]);
    expect(agent.captureSummary()).toEqual({ screenCount: 0, audioCount: 0, keystrokeCount: 0, oldest: null, newest: null });
    expect(search(agent, TYPED_CANARY)).toEqual([]);
  });

  it('is pruned after the same 90 days as screen and microphone text', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece({ ts: NOW - 91 * DAY }));
    agent.ingestKeystrokes(piece({ ts: NOW - 60_000 }));
    expect(agent.prune()).toBeGreaterThanOrEqual(1);
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 1 });
  });

  it('is removed when its app is added to the exclusions', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece({ app: 'Notes', windowClass: 'document' }));
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 1 });
    agent.updateConfig({ excludedApps: [...DEFAULT_CONFIG.excludedApps, 'Notes'] });
    expect(agent.captureSummary()).toMatchObject({ keystrokeCount: 0 });
  });
});

describe('the export shows typed text as a count and dates only', () => {
  it('exports the count and the first and last time, and no typed text', () => {
    const agent = enabled();
    agent.ingestKeystrokes(piece({ ts: NOW - 120_000, text: `first ${TYPED_CANARY}` }));
    agent.ingestKeystrokes(piece({ ts: NOW - 30_000, text: `second ${TYPED_CANARY}` }));
    const exported = agent.exportAll() as { screenCapture: Record<string, unknown> };
    expect(exported.screenCapture).toEqual({
      screenCount: 0,
      audioCount: 0,
      keystrokeCount: 2,
      oldest: new Date(NOW - 120_000).toISOString(),
      newest: new Date(NOW - 30_000).toISOString(),
    });
    expect(JSON.stringify(agent.exportAll())).not.toContain(TYPED_CANARY);
  });
});
