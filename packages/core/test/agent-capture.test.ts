import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_CONFIG,
  TwinAgent,
  type AudioRead,
  type CaptureHitView,
  type CaptureSearchRequest,
  type ScreenRead,
} from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 31, 12);
/** Planted text. Tests check it with includes() and a boolean, so a failing test never prints it. */
const SCREEN_CANARY = 'screen-canary-6120';
const AUDIO_CANARY = 'audio-canary-3874';
const IMAGE_A = '0123456789abcdef0123456789abcdef';
const IMAGE_B = 'fedcba9876543210fedcba9876543210';

function openAgent(now: number = NOW): TwinAgent {
  const dir = temps.folder('twin-capture-agent-');
  return temps.track(new TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => now }));
}

/** An agent with both capture settings switched on, as after the person turns them on. */
function enabled(agent: TwinAgent = openAgent()): TwinAgent {
  agent.updateConfig({ screenCaptureEnabled: true, audioCaptureEnabled: true });
  return agent;
}

function screenRead(overrides: Partial<ScreenRead> = {}): ScreenRead {
  return {
    ts: NOW - 60_000,
    app: 'Microsoft Excel',
    windowClass: 'spreadsheet',
    text: 'Quarterly invoice reviewed',
    mediaId: IMAGE_A,
    ...overrides,
  };
}

function audioRead(overrides: Partial<AudioRead> = {}): AudioRead {
  return { ts: NOW - 30_000, durationMs: 30_000, text: 'Let us move the review to Friday', ...overrides };
}

function search(agent: TwinAgent, text: string, extra: Partial<CaptureSearchRequest> = {}): CaptureHitView[] {
  return agent.searchCapture({ text, from: 0, to: NOW + DAY, ...extra });
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

describe('screen reads', () => {
  it('stores nothing while screen capture is off, which is the default', () => {
    const agent = openAgent();
    expect(DEFAULT_CONFIG.screenCaptureEnabled).toBe(false);
    expect(agent.ingestScreen(screenRead())).toBe(false);
    expect(search(agent, 'invoice')).toEqual([]);
    expect(agent.captureSummary().screenCount).toBe(0);
  });

  it('stores the cleaned text and app, and finds it by a word with the image id as the hit id', () => {
    const agent = enabled();
    const stored = agent.ingestScreen(screenRead({ app: '  Microsoft Excel.app ', text: 'Quarterly   invoice\n----\nreviewed' }));
    expect(stored).toBe(true);
    const hits = search(agent, 'invoice');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'screen', id: IMAGE_A, ts: NOW - 60_000, app: 'microsoft excel' });
    expect(hits[0].snippet).toContain('invoice');
  });

  it('refuses a read that carries a window title, and does not echo the title', () => {
    const agent = enabled();
    const message = messageOf(() => agent.ingestScreen({ ...screenRead(), title: SCREEN_CANARY } as ScreenRead));
    expect(message).toContain('Invalid capture');
    expect(message.includes(SCREEN_CANARY)).toBe(false);
    expect(agent.captureSummary().screenCount).toBe(0);
  });

  it('refuses an image id that is not thirty-two hex characters, and a window class it does not know', () => {
    const agent = enabled();
    expect(() => agent.ingestScreen(screenRead({ mediaId: '../../etc/passwd' }))).toThrow('Invalid capture');
    const unknownClass = 'game' as unknown as ScreenRead['windowClass'];
    expect(() => agent.ingestScreen(screenRead({ windowClass: unknownClass }))).toThrow('Invalid capture');
  });

  it('never stores a browser window or an excluded app, even when the caller asks', () => {
    const agent = enabled();
    expect(agent.ingestScreen(screenRead({ app: 'Microsoft Edge', windowClass: 'browser' }))).toBe(false);
    expect(agent.ingestScreen(screenRead({ app: 'Google Chrome', windowClass: 'other' }))).toBe(false);
    expect(agent.ingestScreen(screenRead({ app: '1Password', windowClass: 'other' }))).toBe(false);
    expect(search(agent, 'invoice')).toEqual([]);
  });

  it('stores nothing for an empty read with no image, but keeps an image with no text', () => {
    const agent = enabled();
    expect(agent.ingestScreen(screenRead({ text: '   ', mediaId: null }))).toBe(false);
    expect(agent.ingestScreen(screenRead({ text: '', mediaId: IMAGE_B }))).toBe(true);
    expect(agent.captureSummary().screenCount).toBe(1);
  });

  it('gives a read with no image an id of its own', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ mediaId: null, text: 'Board notes' }));
    const hits = search(agent, 'Board');
    expect(hits).toHaveLength(1);
    expect(hits[0].id).toMatch(/^[0-9a-f]{32}$/);
    expect(hits[0].id).not.toBe(IMAGE_A);
  });
});

describe('microphone segments', () => {
  it('stores nothing while microphone capture is off', () => {
    const agent = openAgent();
    expect(agent.ingestAudio(audioRead())).toBe(false);
    expect(search(agent, 'Friday')).toEqual([]);
  });

  it('stores the cleaned transcript and finds it, with no app', () => {
    const agent = enabled();
    expect(agent.ingestAudio(audioRead({ text: '[BLANK_AUDIO] move the review to Friday' }))).toBe(true);
    const hits = search(agent, 'Friday');
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'audio', app: null });
    expect(hits[0].snippet).not.toContain('[BLANK_AUDIO]');
  });

  it('drops a segment that is blank once cleaned', () => {
    const agent = enabled();
    expect(agent.ingestAudio(audioRead({ text: '[BLANK_AUDIO]' }))).toBe(false);
    expect(agent.captureSummary().audioCount).toBe(0);
  });

  it('refuses a segment that carries an extra field', () => {
    const agent = enabled();
    expect(() => agent.ingestAudio({ ...audioRead(), app: 'Zoom' } as AudioRead)).toThrow('Invalid capture');
  });
});

describe('search', () => {
  it('treats the words as plain text, not as search syntax', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead());
    expect(search(agent, 'invoice OR payroll')).toEqual([]);
    expect(search(agent, 'AND')).toEqual([]);
    expect(search(agent, '"Quarterly invoice')).toHaveLength(1);
  });

  it('filters by kind and by app', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ text: 'Budget review' }));
    agent.ingestAudio(audioRead({ text: 'Budget call' }));
    expect(search(agent, 'Budget', { kind: 'audio' })).toMatchObject([{ kind: 'audio' }]);
    expect(search(agent, 'Budget', { app: 'Microsoft Excel' })).toMatchObject([{ kind: 'screen' }]);
  });

  it('hides a hit for an app that was excluded after its text was stored', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ app: 'Slack', windowClass: 'chat', text: 'Budget call moved' }));
    expect(search(agent, 'Budget')).toHaveLength(1);
    agent.updateConfig({ excludedApps: [...DEFAULT_CONFIG.excludedApps, 'slack'] });
    expect(search(agent, 'Budget')).toEqual([]);
  });

  it('refuses a request with an extra field or an unknown kind, with a fixed message', () => {
    const agent = enabled();
    expect(() => agent.searchCapture({ text: 'x', from: 0, to: 1, title: SCREEN_CANARY } as CaptureSearchRequest)).toThrow(
      'Invalid search',
    );
    expect(() => agent.searchCapture({ text: 'x', kind: 'video', from: 0, to: 1 } as unknown as CaptureSearchRequest)).toThrow(
      'Invalid search',
    );
  });
});

describe('prune, delete and export', () => {
  it('removes text and images older than ninety days, and returns their image ids', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ ts: NOW - 91 * DAY, mediaId: IMAGE_A, text: 'Old payroll sheet' }));
    agent.ingestAudio(audioRead({ ts: NOW - 91 * DAY, text: 'Old payroll call' }));
    agent.ingestScreen(screenRead({ ts: NOW - 2 * DAY, mediaId: IMAGE_B, text: 'Fresh roadmap' }));

    const result = agent.pruneWithMedia();
    expect(result.mediaIds).toEqual([IMAGE_A]);
    expect(result.removed).toBe(2);
    expect(search(agent, 'payroll')).toEqual([]);
    expect(search(agent, 'roadmap')).toHaveLength(1);
    expect(agent.captureSummary()).toMatchObject({ screenCount: 1, audioCount: 0 });
  });

  it('keeps text that is still inside the ninety days', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ ts: NOW - 89 * DAY, text: 'Recent planning notes' }));
    expect(agent.prune()).toBe(0);
    expect(search(agent, 'planning')).toHaveLength(1);
  });

  it('deletes every captured item and returns the image ids, leaving no text behind', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead());
    agent.ingestScreen(screenRead({ mediaId: null, text: 'No image here' }));
    agent.ingestAudio(audioRead());
    expect(agent.deleteAllCapture()).toEqual([IMAGE_A]);
    expect(agent.captureSummary()).toEqual({ screenCount: 0, audioCount: 0, oldest: null, newest: null });
    expect(search(agent, 'invoice')).toEqual([]);
  });

  it('exports counts and the first and last capture times, and no captured text', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ ts: NOW - 120_000, text: SCREEN_CANARY }));
    agent.ingestAudio(audioRead({ ts: NOW - 30_000, text: AUDIO_CANARY }));
    const exported = JSON.stringify(agent.exportAll());
    expect(exported.includes(SCREEN_CANARY)).toBe(false);
    expect(exported.includes(AUDIO_CANARY)).toBe(false);
    expect((agent.exportAll() as { screenCapture: unknown }).screenCapture).toEqual({
      screenCount: 1,
      audioCount: 1,
      oldest: new Date(NOW - 120_000).toISOString(),
      newest: new Date(NOW - 30_000).toISOString(),
    });
  });
});

describe('image expiry and excluded apps', () => {
  /** An agent whose clock the test moves. With withDeleter, it records every batch of image ids it asks to delete. */
  function clockedAgent(withDeleter = true): { agent: TwinAgent; clock: { now: number }; deleted: string[][] } {
    const clock = { now: NOW };
    const deleted: string[][] = [];
    const agent = temps.track(
      new TwinAgent({
        dataDir: temps.folder('twin-capture-expiry-'),
        dataKey: randomBytes(32),
        now: () => clock.now,
        ...(withDeleter ? { deleteMedia: (mediaIds: string[]) => void deleted.push([...mediaIds]) } : {}),
      }),
    );
    agent.updateConfig({ screenCaptureEnabled: true, audioCaptureEnabled: true, frameRetentionDays: 1 });
    return { agent, clock, deleted };
  }

  it('deletes the images of frames past the frame retention, and keeps their text for the ninety days', () => {
    const { agent, clock, deleted } = clockedAgent();
    agent.ingestScreen(screenRead({ ts: NOW - 2 * DAY, mediaId: IMAGE_A, text: 'Expired frame invoice' }));
    agent.ingestScreen(screenRead({ ts: NOW - 60 * 60_000, mediaId: IMAGE_B, text: 'Recent frame roadmap' }));
    expect(agent.pruneWithMedia()).toEqual({ removed: 0, mediaIds: [] });
    expect(deleted).toEqual([[IMAGE_A]]);
    expect(search(agent, 'invoice').map(hit => hit.id)).toEqual([IMAGE_A]);
    // Later, both images are past the retention. Only the one still named is deleted, and the text is still inside ninety days.
    clock.now = NOW + 30 * DAY;
    expect(agent.pruneWithMedia()).toEqual({ removed: 0, mediaIds: [] });
    expect(deleted).toEqual([[IMAGE_A], [IMAGE_B]]);
    expect(search(agent, 'invoice').map(hit => hit.id)).toEqual([IMAGE_A]);
  });

  it('does not return an image that expired already, when the ninety-day prune removes its text', () => {
    const { agent, deleted } = clockedAgent();
    agent.ingestScreen(screenRead({ ts: NOW - 91 * DAY, mediaId: IMAGE_A, text: 'Ancient frame' }));
    expect(agent.pruneWithMedia()).toEqual({ removed: 1, mediaIds: [] });
    expect(deleted).toEqual([[IMAGE_A]]);
  });

  it('expires no image without a deleteMedia callback, so the caller still gets the image id from the prune', () => {
    const { agent, deleted } = clockedAgent(false);
    agent.ingestScreen(screenRead({ ts: NOW - 91 * DAY, mediaId: IMAGE_A, text: 'Ancient frame without callback' }));
    expect(agent.pruneWithMedia()).toEqual({ removed: 1, mediaIds: [IMAGE_A] });
    expect(deleted).toEqual([]);
  });

  it('purges the text and images of an app once it is excluded, and keeps the text of every other app', () => {
    const { agent, deleted } = clockedAgent();
    agent.ingestScreen(screenRead({ app: 'Acme Planner', mediaId: IMAGE_A, text: 'Planner budget draft' }));
    agent.ingestScreen(screenRead({ app: 'Microsoft Excel', mediaId: IMAGE_B, text: 'Excel budget draft' }));
    expect(search(agent, 'budget')).toHaveLength(2);
    agent.updateConfig({ excludedApps: [...agent.configuration.excludedApps, 'Acme Planner'] });
    expect(deleted).toEqual([[IMAGE_A]]);
    expect(search(agent, 'budget').map(hit => hit.id)).toEqual([IMAGE_B]);
    expect(agent.captureSummary()).toMatchObject({ screenCount: 1, audioCount: 0 });
  });
});

describe('live media ids and size-cap eviction', () => {
  const IMAGE_C = '11223344556677889900aabbccddeeff';

  it('lists the image ids that stored screen items name, once each, and none for an item without an image', () => {
    const agent = enabled();
    expect(agent.liveMediaIds()).toEqual([]);
    agent.ingestScreen(screenRead({ ts: NOW - 120_000, mediaId: IMAGE_A, text: SCREEN_CANARY }));
    agent.ingestScreen(screenRead({ ts: NOW - 60_000, mediaId: IMAGE_B, text: 'Second frame' }));
    agent.ingestScreen(screenRead({ ts: NOW - 30_000, mediaId: null, text: 'Frame without image' }));
    expect([...agent.liveMediaIds()].sort()).toEqual([IMAGE_A, IMAGE_B]);
    agent.deleteAllCapture();
    expect(agent.liveMediaIds()).toEqual([]);
  });

  it('evicts the oldest images up to the limit, clears their references, and keeps their text', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ ts: NOW - 3 * 60_000, mediaId: IMAGE_A, text: 'Oldest frame ledger' }));
    agent.ingestScreen(screenRead({ ts: NOW - 2 * 60_000, mediaId: IMAGE_B, text: 'Middle frame ledger' }));
    agent.ingestScreen(screenRead({ ts: NOW - 60_000, mediaId: IMAGE_C, text: 'Newest frame ledger' }));
    expect(agent.evictScreenMedia(2)).toEqual([IMAGE_A, IMAGE_B]);
    expect(agent.liveMediaIds()).toEqual([IMAGE_C]);
    // The text of an evicted frame is kept and still found, under the id it was stored with.
    expect(search(agent, 'ledger').map(hit => hit.id).sort()).toEqual([IMAGE_A, IMAGE_B, IMAGE_C].sort());
    // A second eviction names only the image still referenced, so no file is named twice.
    expect(agent.evictScreenMedia(10)).toEqual([IMAGE_C]);
    expect(agent.evictScreenMedia(10)).toEqual([]);
    expect(agent.liveMediaIds()).toEqual([]);
  });

  it('returns nothing and clears nothing when no stored item has an image', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ mediaId: null, text: 'Text only frame' }));
    expect(agent.evictScreenMedia(10)).toEqual([]);
    expect(agent.liveMediaIds()).toEqual([]);
    expect(search(agent, 'frame')).toHaveLength(1);
  });

  it('refuses a limit that is not a whole number of at least 1, and clears nothing', () => {
    const agent = enabled();
    agent.ingestScreen(screenRead({ mediaId: IMAGE_A, text: 'Limit frame' }));
    expect(() => agent.evictScreenMedia(0)).toThrow(/whole number of at least 1/);
    expect(() => agent.evictScreenMedia(1.5)).toThrow(/whole number of at least 1/);
    expect(agent.liveMediaIds()).toEqual([IMAGE_A]);
  });

  it('keeps an evicted image out of a later prune, so its file is not named twice', () => {
    const clock = { now: NOW };
    const agent = temps.track(
      new TwinAgent({ dataDir: temps.folder('twin-capture-evict-'), dataKey: randomBytes(32), now: () => clock.now }),
    );
    agent.updateConfig({ screenCaptureEnabled: true });
    agent.ingestScreen(screenRead({ ts: NOW - 91 * DAY, mediaId: IMAGE_A, text: 'Ancient evicted frame' }));
    expect(agent.evictScreenMedia(5)).toEqual([IMAGE_A]);
    expect(agent.pruneWithMedia()).toEqual({ removed: 1, mediaIds: [] });
  });
});
