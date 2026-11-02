import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deriveMediaKey, type ScreenRead } from '@companyos/twin-core';
import { utilityProcess, type UtilityProcess } from 'electron';
import { MediaStore } from '../src/main/media-store';
import {
  forkOcrWorker,
  ScreenCaptureService,
  type Frame,
  type FrameSource,
  type OcrEngine,
  type ScreenContext,
} from '../src/main/screen-capture';

vi.mock('electron', () => ({
  nativeImage: {
    createFromBuffer: (png: Buffer) => {
      const jpeg = Buffer.from(`jpeg:${png.toString()}`);
      const image = { isEmpty: () => png.length === 0, getSize: () => ({ width: 800, height: 450 }), toJPEG: () => jpeg };
      return { ...image, resize: () => image };
    },
  },
  desktopCapturer: { getSources: vi.fn() },
  screen: { getPrimaryDisplay: vi.fn() },
  utilityProcess: { fork: vi.fn() },
}));

/** Planted in the frame text. It is checked only by the store, and never printed. */
const CANARY = 'SCREEN_OCR_CANARY_4471';
const WIDTH = 16;
const HEIGHT = 9;

/** A frame where every pixel has one value. Two frames with the same value match, and two values do not. */
function frameOf(shade: number, label: string): Frame {
  return { width: WIDTH, height: HEIGHT, bgra: Buffer.alloc(WIDTH * HEIGHT * 4, shade), png: Buffer.from(label) };
}

class FakeSource implements FrameSource {
  next: Frame | null = null;
  grabs = 0;
  fail = false;

  async grab(): Promise<Frame | null> {
    this.grabs++;
    if (this.fail) throw new Error('The grab failed.');
    return this.next;
  }
}

/** Reads the frame label as its text. A gate holds every read until it is opened. */
class FakeOcr implements OcrEngine {
  calls: string[] = [];
  finished = 0;
  gate: Promise<void> | undefined;
  text = (label: string): string => `the words of ${label}`;
  failNext = false;

  async recognise(png: Buffer): Promise<string> {
    const label = png.toString();
    this.calls.push(label);
    if (this.gate) await this.gate;
    this.finished++;
    if (this.failNext) {
      this.failNext = false;
      throw new Error('The read failed.');
    }
    return label.startsWith('blank') ? '   ' : this.text(label);
  }
}

const OPEN: ScreenContext = {
  enabled: true,
  locked: false,
  paused: false,
  idle: false,
  appExcluded: false,
  windowClass: 'editor',
  permissionGranted: true,
  app: 'Notes',
};

describe('ScreenCaptureService', () => {
  /** Everything one test touches. A service keeps its own copy, so a read left over from an earlier test cannot reach this one. */
  interface World {
    mediaDir: string;
    source: FakeSource;
    ocr: FakeOcr;
    rows: ScreenRead[];
    sinkCalls: number;
    sinkAccepts: boolean;
    secure: boolean | 'unknown' | 'error';
    service: ScreenCaptureService;
  }
  let w: World;
  let base: string;

  function newWorld(folder: string): World {
    const mediaDir = join(folder, 'media');
    const world = {
      mediaDir,
      source: new FakeSource(),
      ocr: new FakeOcr(),
      rows: [] as ScreenRead[],
      sinkCalls: 0,
      sinkAccepts: true,
      secure: false as boolean | 'unknown' | 'error',
    } as World;
    world.service = new ScreenCaptureService({
      source: world.source,
      ocr: world.ocr,
      media: new MediaStore(mediaDir, deriveMediaKey(randomBytes(32))),
      sink: {
        ingestScreen: read => {
          world.sinkCalls++;
          if (world.sinkAccepts) world.rows.push(read);
          return world.sinkAccepts;
        },
      },
      now: () => Date.now(),
      secureInput: async () => {
        if (world.secure === 'error') throw new Error('The probe failed.');
        return world.secure;
      },
    });
    world.service.setContext(OPEN);
    world.service.start(60_000);
    return world;
  }

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), 'screen-capture-test-'));
    w = newWorld(base);
  });

  afterEach(async () => {
    // The timers were made with the clock in effect, so the real clock is restored before the service is stopped.
    vi.useRealTimers();
    vi.unstubAllGlobals();
    // Waiting for stop lets any read still under way finish before its folder is removed.
    await w.service.stop();
    rmSync(base, { recursive: true, force: true });
  });

  function mediaFiles(): string[] {
    try {
      return readdirSync(w.mediaDir);
    } catch {
      return [];
    }
  }

  it('stores the text of a new frame with the id of its sealed image', async () => {
    w.source.next = frameOf(10, `frame-${CANARY}`);
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.rows).toHaveLength(1));
    // Boolean checks, so a failure shows true or false and never the planted text.
    expect(w.rows[0].text.includes(CANARY)).toBe(true);
    expect(w.rows[0].app).toBe('Notes');
    expect(w.rows[0].windowClass).toBe('editor');
    expect(w.rows[0].mediaId).toMatch(/^[0-9a-f]{32}$/);
    expect(mediaFiles()).toEqual([`${w.rows[0].mediaId}.bin`]);
    expect(readFileSync(join(w.mediaDir, `${w.rows[0].mediaId}.bin`)).includes(Buffer.from(CANARY))).toBe(false);
  });

  it('skips a frame that repeats the last kept frame, with no OCR and no storage', async () => {
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.rows).toHaveLength(1));

    w.source.next = frameOf(10, 'frame-one-again');
    await w.service.requestFrame('interval');

    expect(w.source.grabs).toBe(2);
    expect(w.ocr.calls).toEqual(['frame-one']);
    expect(w.rows).toHaveLength(1);
  });

  it('grabs nothing while the screen is locked', async () => {
    w.service.setContext({ ...OPEN, locked: true });
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
    expect(w.ocr.calls).toEqual([]);
    expect(w.rows).toEqual([]);
  });

  it('grabs nothing while capture is off, and nothing before a context is set', async () => {
    w.service.setContext({ ...OPEN, enabled: false });
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);

    w.service.setContext(null);
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
  });

  it('grabs nothing while secure input is on', async () => {
    w.secure = true;
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
    expect(w.rows).toEqual([]);
  });

  it('grabs nothing when secure input cannot be checked, or the check itself fails', async () => {
    w.secure = 'unknown';
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    w.secure = 'error';
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
    expect(w.rows).toEqual([]);
  });

  it('grabs nothing while a browser window is focused', async () => {
    w.service.setContext({ ...OPEN, windowClass: 'browser' });
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
  });

  it('keeps only the newest frame while a read is in flight', async () => {
    let release!: () => void;
    w.ocr.gate = new Promise<void>(resolve => {
      release = resolve;
    });

    w.source.next = frameOf(10, 'first');
    await w.service.requestFrame('interval');
    expect(w.ocr.calls).toEqual(['first']);

    w.source.next = frameOf(20, 'second');
    await w.service.requestFrame('interval');
    w.source.next = frameOf(30, 'third');
    await w.service.requestFrame('interval');
    expect(w.ocr.calls).toEqual(['first']);

    release();
    await vi.waitFor(() => expect(w.rows).toHaveLength(2));
    expect(w.ocr.calls).toEqual(['first', 'third']);
    expect(w.rows.map(row => row.text)).toEqual(['the words of first', 'the words of third']);
  });

  it('keeps nothing for a frame locked during its read', async () => {
    let release!: () => void;
    w.ocr.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');

    w.service.setContext({ ...OPEN, locked: true });
    release();
    await vi.waitFor(() => expect(w.ocr.finished).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(w.rows).toEqual([]);
    expect(mediaFiles()).toEqual([]);
  });

  it('stop drops a frame that is still being read and resolves once that read has ended', async () => {
    let release!: () => void;
    w.ocr.gate = new Promise<void>(resolve => {
      release = resolve;
    });
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');

    const stopped = w.service.stop();
    release();
    await stopped;
    expect(w.ocr.finished).toBe(1);
    expect(w.rows).toEqual([]);
    expect(mediaFiles()).toEqual([]);
  });

  it('removes the image when the text is not stored', async () => {
    w.sinkAccepts = false;
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => {
      expect(w.sinkCalls).toBe(1);
      expect(mediaFiles()).toEqual([]);
    });
  });

  it('keeps no image for a frame with no text', async () => {
    w.source.next = frameOf(10, 'blank-frame');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.ocr.finished).toBe(1));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(w.rows).toEqual([]);
    expect(mediaFiles()).toEqual([]);
  });

  it('a failed grab keeps nothing and does not throw', async () => {
    w.source.fail = true;
    w.source.next = frameOf(10, 'frame-one');
    await expect(w.service.requestFrame('interval')).resolves.toBeUndefined();
    expect(w.rows).toEqual([]);
  });

  it('a failed read keeps nothing, and the next frame is still read', async () => {
    w.ocr.failNext = true;
    w.source.next = frameOf(10, 'first');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.ocr.finished).toBe(1));

    w.source.next = frameOf(20, 'second');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.rows).toHaveLength(1));
    expect(w.rows[0].text).toBe('the words of second');
  });

  it('a stopped service captures nothing', async () => {
    await w.service.stop();
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    expect(w.source.grabs).toBe(0);
  });

  it('shares one debounced grab across a burst of focus changes', async () => {
    vi.useFakeTimers();
    w.source.next = frameOf(10, 'frame-one');
    const first = w.service.requestFrame('focus');
    await vi.advanceTimersByTimeAsync(500);
    const second = w.service.requestFrame('focus');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(w.source.grabs).toBe(0);
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([first, second]);
    expect(w.source.grabs).toBe(1);
  });

  it('makes no network call during a capture', async () => {
    const fetchSpy = vi.fn(() => Promise.reject(new Error('The network is not allowed.')));
    vi.stubGlobal('fetch', fetchSpy);
    w.source.next = frameOf(10, 'frame-one');
    await w.service.requestFrame('interval');
    await vi.waitFor(() => expect(w.rows).toHaveLength(1));
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

/** A worker stand-in. Tests send its replies with emit, as the utility process would. */
class FakeWorker extends EventEmitter {
  posted: unknown[] = [];
  postMessage = vi.fn((message: unknown) => {
    this.posted.push(message);
  });
  kill = vi.fn(() => {
    this.emit('exit', 0);
  });
}

describe('forkOcrWorker', () => {
  let worker: FakeWorker;

  beforeEach(() => {
    worker = new FakeWorker();
    vi.mocked(utilityProcess.fork).mockReturnValue(worker as unknown as UtilityProcess);
  });

  it('resolves with the text the worker replies with', async () => {
    const engine = forkOcrWorker('/unused/ocr-worker.js');
    const pending = engine.recognise(Buffer.from('frame'));
    const request = worker.posted[0] as { id: number; type: string };
    expect(request.type).toBe('recognise');
    worker.emit('message', { type: 'text', id: request.id, text: 'hello there' });
    await expect(pending).resolves.toBe('hello there');
  });

  it('rejects with a fixed message when the worker reports a failure, and never with its details', async () => {
    const engine = forkOcrWorker('/unused/ocr-worker.js');
    const pending = engine.recognise(Buffer.from('frame'));
    const request = worker.posted[0] as { id: number };
    worker.emit('message', { type: 'failed', id: request.id, stage: 'recognise' });
    await expect(pending).rejects.toThrow('The frame could not be read.');
  });

  it('rejects a read still waiting when the worker exits', async () => {
    const engine = forkOcrWorker('/unused/ocr-worker.js');
    const pending = engine.recognise(Buffer.from('frame'));
    worker.emit('exit', 1);
    await expect(pending).rejects.toThrow('The frame could not be read.');
  });
});
