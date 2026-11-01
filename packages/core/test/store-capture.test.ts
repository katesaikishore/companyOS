import { readdirSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore, MAX_CAPTURE_HITS, type CaptureQuery, type CaptureRecord } from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

/** Planted text. It must never appear in a stored file, an error message or a log. */
const CANARY = 'screen-canary-4417';
const AUDIO_CANARY = 'audio-canary-9033';
const CUT = Date.UTC(2026, 9, 1);

function freshDir(): string {
  return temps.folder('twin-capture-');
}

/** Raw bytes of every file in the store folder: the database, its WAL and shared memory. */
function rawFiles(dir: string): Buffer[] {
  return readdirSync(dir).map(name => readFileSync(join(dir, name)));
}

function screen(id: string, ts: number, text: string, options: { app?: string | null; mediaId?: string | null } = {}): CaptureRecord {
  return {
    collection: 'screenText',
    kind: 'screen',
    id,
    ts,
    app: options.app === undefined ? 'Notes' : options.app,
    text,
    body: { mediaId: options.mediaId ?? null, windowClass: 'document' },
  };
}

function audio(id: string, ts: number, text: string): CaptureRecord {
  return { collection: 'audioText', kind: 'audio', id, ts, app: null, text, body: { durationMs: 30_000 } };
}

function query(overrides: Partial<CaptureQuery> = {}): CaptureQuery {
  return { terms: [], from: 0, to: Number.MAX_SAFE_INTEGER, limit: 50, ...overrides };
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

describe('captured text in the encrypted store', () => {
  it('refuses the capture collections through append and replaceAll', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    expect(() => store.append('screenText', { a: 1 })).toThrow(/appendCapture/);
    expect(() => store.append('audioText', { a: 1 })).toThrow(/appendCapture/);
    expect(() => store.replaceAll('screenText', [])).toThrow(/appendCapture/);
    expect(() => store.replaceAll('audioText', [])).toThrow(/appendCapture/);
    store.close();
  });

  it('finds a stored screen item by a word in its text, with its kind, id, time and app', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-1', CUT, 'Quarterly invoice reviewed with finance', { app: 'Mail' }));
    const hits = store.searchCapture(query({ terms: ['invoice'] }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ kind: 'screen', id: 'cap-1', ts: CUT, app: 'Mail' });
    expect(hits[0].snippet).toContain('invoice');
    expect(store.searchCapture(query({ terms: ['payroll'] }))).toEqual([]);
    store.close();
  });

  it('matches the last word as a prefix and the others as whole words', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-1', CUT, 'Invoice approved for the supplier'));
    expect(store.searchCapture(query({ terms: ['invoi'] }))).toHaveLength(1);
    expect(store.searchCapture(query({ terms: ['invoice', 'appro'] }))).toHaveLength(1);
    expect(store.searchCapture(query({ terms: ['approved', 'invoice'] }))).toHaveLength(1);
    expect(store.searchCapture(query({ terms: ['supp', 'invoice'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['invoice', 'supp'] }))).toHaveLength(1);
    store.close();
  });

  it('treats search syntax from the person as plain words, never as operators', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-1', CUT, 'salt and pepper, alpha beta'));
    expect(store.searchCapture(query({ terms: ['AND'] }))).toHaveLength(1);
    expect(store.searchCapture(query({ terms: ['NEAR(alpha beta'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['"'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['*'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['col:alpha'] }))).toEqual([]);
    // A quote inside a word is text too, so the word still matches on its letters.
    expect(store.searchCapture(query({ terms: ['"alpha'] }))).toHaveLength(1);
    store.close();
  });

  it('matches without accents', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-1', CUT, 'Café meeting notes'));
    expect(store.searchCapture(query({ terms: ['cafe'] }))).toHaveLength(1);
    store.close();
  });

  it('filters by kind, app and an inclusive time range, and returns the newest first', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('s-old', 1_000, 'report draft', { app: 'Notes' }));
    store.appendCapture(screen('s-new', 2_000, 'report final', { app: 'Mail' }));
    store.appendCapture(audio('a-mid', 1_500, 'report read aloud'));
    expect(store.searchCapture(query({ terms: ['report'] })).map(hit => hit.id)).toEqual(['s-new', 'a-mid', 's-old']);
    expect(store.searchCapture(query({ terms: ['report'], kind: 'audio' })).map(hit => hit.id)).toEqual(['a-mid']);
    expect(store.searchCapture(query({ terms: ['report'], kind: 'screen', app: 'Mail' })).map(hit => hit.id)).toEqual(['s-new']);
    expect(store.searchCapture(query({ terms: ['report'], from: 1_000, to: 1_500 })).map(hit => hit.id)).toEqual(['a-mid', 's-old']);
    expect(store.searchCapture(query({ from: 1_000, to: 1_999 })).map(hit => hit.id)).toEqual(['a-mid', 's-old']);
    store.close();
  });

  it('returns no more than the limit, and caps a larger limit at the maximum', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    for (let i = 0; i < MAX_CAPTURE_HITS + 1; i++) store.appendCapture(screen(`cap-${i}`, CUT + i, 'ledger line'));
    expect(store.searchCapture(query({ terms: ['ledger'], limit: 2 })).map(hit => hit.id)).toEqual([
      `cap-${MAX_CAPTURE_HITS}`,
      `cap-${MAX_CAPTURE_HITS - 1}`,
    ]);
    expect(store.searchCapture(query({ terms: ['ledger'], limit: 100_000 }))).toHaveLength(MAX_CAPTURE_HITS);
    expect(() => store.searchCapture(query({ limit: 0 }))).toThrow(/whole number of at least 1/);
    expect(() => store.searchCapture(query({ limit: 1.5 }))).toThrow(/whole number of at least 1/);
    store.close();
  });

  it('rejects a kind that does not match its collection, without echoing the text', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    const message = messageOf(() => store.appendCapture({ ...screen('x', CUT, CANARY), collection: 'audioText' }));
    expect(message).toBe('Capture kind does not match its collection.');
    expect(message.includes(CANARY)).toBe(false);
    expect(store.captureCounts()).toEqual({ screen: 0, audio: 0 });
    store.close();
  });

  it('rejects a time that is not a whole number of milliseconds', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    expect(() => store.appendCapture(screen('x', 1.5, CANARY))).toThrow(/whole number of milliseconds/);
    store.close();
  });

  it('never writes the captured text to disk in readable form, and keeps it searchable across a reopen', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = temps.track(new EncryptedStore(dir, key));
    store.appendCapture(screen('cap-1', CUT, CANARY, { mediaId: 'media-1' }));
    store.appendCapture(audio('aud-1', CUT + 1, AUDIO_CANARY));
    // The WAL exists while the store is open, so the check covers it as well as the main file.
    const open = rawFiles(dir);
    expect(open.length).toBeGreaterThan(1);
    store.close();
    for (const raw of [...open, ...rawFiles(dir)]) {
      expect(raw.includes(CANARY)).toBe(false);
      expect(raw.includes(AUDIO_CANARY)).toBe(false);
      expect(raw.includes('capture_fts')).toBe(false);
    }
    const reopened = temps.track(new EncryptedStore(dir, key));
    expect(reopened.searchCapture(query({ terms: ['canary'] }))).toHaveLength(2);
    expect(reopened.readAll('screenText')).toEqual([{ mediaId: 'media-1', windowClass: 'document' }]);
    reopened.close();
  });

  it('prunes old items, their text and their index rows, and returns the images of the removed screen items', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('old-shot', CUT - 1, `${CANARY} pruned`, { mediaId: 'media-old' }));
    store.appendCapture(screen('old-bare', CUT - 2, 'bare line', { mediaId: null }));
    store.appendCapture(audio('old-audio', CUT - 3, `${AUDIO_CANARY} pruned`));
    store.appendCapture(screen('kept-shot', CUT + 1, 'kept line', { mediaId: 'media-kept' }));
    expect(store.pruneCapture(CUT)).toEqual({ removed: 3, mediaIds: ['media-old'] });
    expect(store.searchCapture(query({ terms: ['canary'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['bare'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['kept'] })).map(hit => hit.id)).toEqual(['kept-shot']);
    expect(store.captureCounts()).toEqual({ screen: 1, audio: 0 });
    store.close();
  });

  it('deletes all captured items and reports the screen images, and leaves other collections alone', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.append('events', { kind: 'focus', app: 'Mail' });
    store.appendCapture(screen('cap-1', CUT, CANARY, { mediaId: 'media-1' }));
    store.appendCapture(screen('cap-2', CUT + 1, 'no image', { mediaId: null }));
    store.appendCapture(audio('aud-1', CUT + 2, AUDIO_CANARY));
    expect(store.deleteAllCapture()).toEqual({ mediaIds: ['media-1'] });
    expect(store.captureCounts()).toEqual({ screen: 0, audio: 0 });
    expect(store.searchCapture(query({ terms: ['canary'] }))).toEqual([]);
    expect(store.searchCapture(query())).toEqual([]);
    expect(store.readAll('events')).toEqual([{ kind: 'focus', app: 'Mail' }]);
    // The index keeps working for items stored after the wipe.
    store.appendCapture(screen('cap-3', CUT + 3, 'fresh line'));
    expect(store.searchCapture(query({ terms: ['fresh'] })).map(hit => hit.id)).toEqual(['cap-3']);
    store.close();
  });

  it('counts stored items by kind', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    expect(store.captureCounts()).toEqual({ screen: 0, audio: 0 });
    store.appendCapture(screen('cap-1', CUT, 'one'));
    store.appendCapture(screen('cap-2', CUT + 1, 'two'));
    store.appendCapture(audio('aud-1', CUT + 2, 'three'));
    expect(store.captureCounts()).toEqual({ screen: 2, audio: 1 });
    store.close();
  });

  it('lists the oldest screen items that have an image, oldest first, skipping audio and items with no image', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-c', CUT + 300, 'c', { mediaId: 'media-c' }));
    store.appendCapture(screen('cap-a', CUT + 100, 'a', { mediaId: 'media-a' }));
    store.appendCapture(screen('cap-none', CUT + 200, 'none', { mediaId: null }));
    store.appendCapture(audio('aud-1', CUT + 50, 'audio'));
    store.appendCapture(screen('cap-b', CUT + 250, 'b', { mediaId: 'media-b' }));
    expect(store.oldestScreenMedia(10)).toEqual([
      { id: 'cap-a', mediaId: 'media-a', ts: CUT + 100 },
      { id: 'cap-b', mediaId: 'media-b', ts: CUT + 250 },
      { id: 'cap-c', mediaId: 'media-c', ts: CUT + 300 },
    ]);
    expect(store.oldestScreenMedia(1)).toEqual([{ id: 'cap-a', mediaId: 'media-a', ts: CUT + 100 }]);
    expect(() => store.oldestScreenMedia(0)).toThrow(/whole number of at least 1/);
    store.close();
  });

  it('is empty after a wipe, so nothing from the index survives the store', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = temps.track(new EncryptedStore(dir, key));
    store.appendCapture(screen('cap-1', CUT, CANARY));
    store.wipe();
    const reopened = temps.track(new EncryptedStore(dir, key));
    expect(reopened.captureCounts()).toEqual({ screen: 0, audio: 0 });
    expect(reopened.searchCapture(query({ terms: ['canary'] }))).toEqual([]);
    reopened.close();
  });
});

describe('capture index, image references and app deletion', () => {
  it('has no search index until the first capture is written, so every read finds nothing', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const store = temps.track(new EncryptedStore(dir, key));
    store.append('events', { kind: 'focus', app: 'Mail' });
    expect(store.searchCapture(query())).toEqual([]);
    expect(store.searchCapture(query({ terms: ['anything'] }))).toEqual([]);
    expect(store.oldestScreenMedia(5)).toEqual([]);
    expect(store.captureApps()).toEqual([]);
    expect(store.pruneCapture(CUT)).toEqual({ removed: 0, mediaIds: [] });
    expect(store.deleteAllCapture()).toEqual({ mediaIds: [] });
    expect(store.deleteCaptureForApp('Notes')).toEqual({ mediaIds: [] });
    store.clearCaptureMedia(['media-none']);
    store.close();
    const reopened = temps.track(new EncryptedStore(dir, key));
    expect(reopened.searchCapture(query({ terms: ['anything'] }))).toEqual([]);
    expect(reopened.readAll('events')).toEqual([{ kind: 'focus', app: 'Mail' }]);
    reopened.close();
  });

  it('clears the image reference of the given screen items and keeps their text', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('media-a', CUT, 'first line', { mediaId: 'media-a' }));
    store.appendCapture(screen('media-b', CUT + 1, 'second line', { mediaId: 'media-b' }));
    store.clearCaptureMedia(['media-a']);
    expect(store.oldestScreenMedia(10)).toEqual([{ id: 'media-b', mediaId: 'media-b', ts: CUT + 1 }]);
    expect(store.searchCapture(query({ terms: ['first'] })).map(hit => hit.id)).toEqual(['media-a']);
    expect(store.readAll('screenText')).toEqual([
      { mediaId: null, windowClass: 'document' },
      { mediaId: 'media-b', windowClass: 'document' },
    ]);
    // Ids that are not stored change nothing, and clearing an item twice is harmless.
    store.clearCaptureMedia(['media-none', 'media-a']);
    expect(store.oldestScreenMedia(10)).toHaveLength(1);
    expect(store.pruneCapture(CUT + 10)).toEqual({ removed: 2, mediaIds: ['media-b'] });
    store.close();
  });

  it('deletes the items of one app with their text, returns their images, and keeps every other app', () => {
    const store = temps.track(new EncryptedStore(freshDir(), randomBytes(32)));
    store.appendCapture(screen('cap-1', CUT, 'alpha note', { app: 'Notes', mediaId: 'media-1' }));
    store.appendCapture(screen('cap-2', CUT + 1, 'beta note', { app: 'Notes', mediaId: null }));
    store.appendCapture(screen('cap-3', CUT + 2, 'gamma sheet', { app: 'Excel', mediaId: 'media-3' }));
    store.appendCapture(audio('aud-1', CUT + 3, 'delta speech'));
    expect(store.captureApps().sort()).toEqual(['Excel', 'Notes']);
    expect(store.deleteCaptureForApp('Notes')).toEqual({ mediaIds: ['media-1'] });
    expect(store.searchCapture(query({ terms: ['alpha'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['beta'] }))).toEqual([]);
    expect(store.searchCapture(query({ terms: ['gamma'] })).map(hit => hit.id)).toEqual(['cap-3']);
    expect(store.searchCapture(query({ terms: ['delta'] })).map(hit => hit.id)).toEqual(['aud-1']);
    expect(store.captureApps().sort()).toEqual(['Excel']);
    expect(store.captureCounts()).toEqual({ screen: 1, audio: 1 });
    expect(store.deleteCaptureForApp('Notes')).toEqual({ mediaIds: [] });
    store.close();
  });
});
