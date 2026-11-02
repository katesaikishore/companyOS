import { mkdtempSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TwinAgent } from '../src/agent';
import { screenDecision, type ScreenState } from '../src/capture-policy';
import { DEFAULT_CONFIG } from '../src/types';

const OPEN: ScreenState = {
  enabled: true,
  locked: false,
  paused: false,
  idle: false,
  appExcluded: false,
  windowClass: 'editor',
  secureInput: false,
  permissionGranted: true,
};

describe('window-class exclusions', () => {
  it('is empty by default, so nothing is excluded until the person chooses', () => {
    expect(DEFAULT_CONFIG.excludedWindowClasses).toEqual([]);
  });

  it('skips a window whose class is excluded, and says why', () => {
    const decision = screenDecision({ ...OPEN, windowExcluded: true });
    expect(decision.capture).toBe(false);
    expect(decision.reason).toMatch(/window is excluded/);
  });

  it('reads a window whose class is not excluded', () => {
    expect(screenDecision({ ...OPEN, windowExcluded: false }).capture).toBe(true);
    expect(screenDecision(OPEN).capture).toBe(true);
  });

  describe('at ingest', () => {
    let dir: string;
    let agent: TwinAgent;

    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), 'window-filters-'));
      agent = new TwinAgent({ dataDir: join(dir, 'twin'), dataKey: randomBytes(32), now: () => Date.UTC(2026, 10, 2, 9) });
      agent.updateConfig({ screenCaptureEnabled: true, excludedWindowClasses: ['chat'] });
    });

    afterEach(() => {
      agent.close();
      rmSync(dir, { recursive: true, force: true });
    });

    it('refuses a read from an excluded class even when the app is not excluded', () => {
      const stored = agent.ingestScreen({
        ts: Date.UTC(2026, 10, 2, 9),
        app: 'Notes',
        windowClass: 'chat',
        text: 'a note in a chat window',
        mediaId: null,
      });
      expect(stored).toBe(false);
      expect(agent.captureSummary().screenCount).toBe(0);
    });

    it('stores a read from a class that is not excluded', () => {
      const stored = agent.ingestScreen({
        ts: Date.UTC(2026, 10, 2, 9),
        app: 'Notes',
        windowClass: 'editor',
        text: 'a note in an editor',
        mediaId: null,
      });
      expect(stored).toBe(true);
      expect(agent.captureSummary().screenCount).toBe(1);
    });
  });
});

describe('window-class exclusions remove what was already stored', () => {
  let dir: string;
  let agent: TwinAgent;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'window-purge-'));
    agent = new TwinAgent({ dataDir: join(dir, 'twin'), dataKey: randomBytes(32), now: () => Date.UTC(2026, 10, 2, 9) });
    agent.updateConfig({ screenCaptureEnabled: true });
  });

  afterEach(() => {
    agent.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('removes stored text of a kind that is excluded afterwards, and keeps the other kinds', () => {
    const ts = Date.UTC(2026, 10, 2, 9);
    agent.ingestScreen({ ts, app: 'Notes', windowClass: 'editor', text: 'kept editor words', mediaId: null });
    agent.ingestScreen({ ts, app: 'Slack', windowClass: 'chat', text: 'stored chat words', mediaId: null });
    expect(agent.captureSummary().screenCount).toBe(2);
    agent.updateConfig({ excludedWindowClasses: ['chat'] });
    expect(agent.captureSummary().screenCount).toBe(1);
    const hits = agent.searchCapture({ text: 'chat words', from: 0, to: Date.UTC(2027, 0, 1) });
    expect(hits).toHaveLength(0);
    expect(agent.searchCapture({ text: 'editor words', from: 0, to: Date.UTC(2027, 0, 1) })).toHaveLength(1);
  });
});
