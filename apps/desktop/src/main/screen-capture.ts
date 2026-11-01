import {
  FrameDeduper,
  fingerprintBitmap,
  newId,
  normaliseOcr,
  screenDecision,
  type ScreenRead,
  type ScreenState,
} from '@companyos/twin-core';
import { desktopCapturer, nativeImage, screen, utilityProcess, type UtilityProcess } from 'electron';
import type { MediaStore } from './media-store';
import type { OcrRequest, OcrResponse } from './ocr-worker';

/**
 * Takes still frames of the primary display while screen capture is on. A frame passes the policy, is skipped when it
 * repeats the last kept frame, is read by OCR, and is stored as a sealed image with its text. Nothing here reaches the
 * network: the frame, the text and the image stay in this process, the media folder and the encrypted store.
 */
const DEFAULT_INTERVAL_MS = 5_000;
/** A focus change waits this long, so a burst of window switches costs one frame. */
const FOCUS_DEBOUNCE_MS = 1_500;
/** When the recent reads average longer than SLOW_OCR_MS, frames come less often, so a slow machine is not kept busy. */
const SLOW_OCR_MS = 3_000;
const SLOW_INTERVAL_MS = 15_000;
const RECENT_READS = 8;
/** The widest frame OCR reads. Text at this width is legible, and a wider frame costs time for little gain. */
const OCR_WIDTH = 2_000;
/** The widest image kept, and its JPEG quality. A kept frame is about 120 KB at these settings. */
const KEEP_WIDTH = 1_280;
const KEEP_QUALITY = 60;
/** A read that takes this long is treated as stuck. The worker is restarted and the frame is dropped. */
const OCR_TIMEOUT_MS = 60_000;
const OCR_FAILED = 'The frame could not be read.';

export interface Frame {
  width: number;
  height: number;
  /** The raw pixels, used only to tell two frames apart. The byte order does not matter for that. */
  bgra: Buffer;
  /** The frame as PNG at OCR_WIDTH. OCR reads it, and it is not kept. */
  png: Buffer;
}

export interface FrameSource {
  /** Grabs the primary display. Null when nothing can be grabbed, for example without screen recording permission. */
  grab(): Promise<Frame | null>;
}

export interface OcrEngine {
  /** The text of one PNG frame. Rejects when the frame cannot be read. */
  recognise(png: Buffer): Promise<string>;
}

/** What the service needs to know about the screen right now. The runtime sets it on each focus, lock, pause and idle change. */
export interface ScreenContext extends Omit<ScreenState, 'secureInput'> {
  /** The focused app, as the agent names it. Null when none is known. */
  app: string | null;
}

export type FrameReason = 'focus' | 'interval';

export interface ScreenCaptureDeps {
  source: FrameSource;
  ocr: OcrEngine;
  media: Pick<MediaStore, 'write' | 'remove'>;
  sink: { ingestScreen(read: ScreenRead): boolean };
  now: () => number;
  /** Whether a secure field may hold focus. Rejecting counts as unknown, so the frame is skipped. */
  secureInput: () => Promise<boolean | 'unknown'>;
}

interface Job {
  ts: number;
  context: ScreenContext;
  png: Buffer;
  /** The capture generation the frame was taken in. A stop or a delete moves the generation on, so an older frame is dropped. */
  generation: number;
}

/** The longest a state check or a grab may take before the cycle gives up. The chain then goes on with the next frame. */
const CHECK_TIMEOUT_MS = 15_000;

/** Resolves with the promise's value, or with the fallback when it rejects or takes longer than ms. */
function settleWithin<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>(resolve => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/** Turns a frame into the JPEG kept on disk, scaled down so that each image stays small. */
function encodeJpeg(png: Buffer): Buffer {
  const image = nativeImage.createFromBuffer(png);
  if (image.isEmpty()) throw new Error(OCR_FAILED);
  const { width } = image.getSize();
  return (width > KEEP_WIDTH ? image.resize({ width: KEEP_WIDTH }) : image).toJPEG(KEEP_QUALITY);
}

export class ScreenCaptureService {
  private context: ScreenContext | null = null;
  private running = false;
  private grabbing = false;
  /** Set while a read is in flight. It resolves when the read and its storage have ended. */
  private draining: Promise<void> | undefined;
  /** Set while a cycle is checking the state or grabbing the screen. A stop waits for it too. */
  private cycling: Promise<void> | undefined;
  /** Moves on at every stop, so frames taken before it are never stored after it. */
  private generation = 0;
  /** The one frame waiting to be read. A newer frame replaces it, so a slow read never builds a queue. */
  private pending: Job | null = null;
  private deduper = new FrameDeduper();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private intervalBaseMs = DEFAULT_INTERVAL_MS;
  private readonly recentReads: number[] = [];
  private focus: { timer: ReturnType<typeof setTimeout> | undefined; done: Promise<void>; resolve: () => void } | undefined;

  constructor(private readonly deps: ScreenCaptureDeps) {}

  /** Starts the interval. The first frame comes one interval later. Nothing is captured until setContext allows it. */
  start(intervalMs = DEFAULT_INTERVAL_MS): void {
    if (this.running) return;
    this.running = true;
    this.intervalBaseMs = intervalMs;
    this.deduper = new FrameDeduper();
    this.schedule();
  }

  /**
   * Stops capture. A frame waiting to be read is dropped, and a read that has not reached its last check is not stored.
   * The promise resolves once any read in progress has ended, so a caller about to delete the media folder can wait.
   */
  stop(): Promise<void> {
    this.running = false;
    this.generation += 1;
    clearTimeout(this.timer);
    this.timer = undefined;
    this.pending = null;
    if (this.focus) {
      clearTimeout(this.focus.timer);
      this.focus.resolve();
      this.focus = undefined;
    }
    const inFlight = [this.draining, this.cycling].filter((work): work is Promise<void> => work !== undefined);
    return Promise.all(inFlight).then(() => undefined);
  }

  setContext(context: ScreenContext | null): void {
    this.context = context;
  }

  /**
   * Asks for one frame. An interval frame runs now. A focus frame waits for the focus to settle, and every call in that
   * wait shares one result. The promise resolves once the frame has been handed to OCR or dropped, not once it is read.
   */
  requestFrame(reason: FrameReason): Promise<void> {
    if (reason === 'interval') return this.cycle();
    return this.debounceFocus();
  }

  private intervalMs(): number {
    const reads = this.recentReads;
    const mean = reads.length > 0 ? reads.reduce((sum, ms) => sum + ms, 0) / reads.length : 0;
    return mean > SLOW_OCR_MS ? Math.max(this.intervalBaseMs, SLOW_INTERVAL_MS) : this.intervalBaseMs;
  }

  private schedule(): void {
    // One chain only. A cycle that finishes after a stop and start must not add a second timer.
    clearTimeout(this.timer);
    if (!this.running) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      // The next frame is timed from the end of this cycle. A cycle never waits for OCR.
      void this.requestFrame('interval').finally(() => this.schedule());
    }, this.intervalMs());
  }

  private debounceFocus(): Promise<void> {
    if (!this.focus) {
      let resolve: () => void = () => undefined;
      const done = new Promise<void>(settle => {
        resolve = () => settle();
      });
      this.focus = { timer: undefined, done, resolve };
    }
    const focus = this.focus;
    clearTimeout(focus.timer);
    focus.timer = setTimeout(() => {
      this.focus = undefined;
      void this.cycle().finally(focus.resolve);
    }, FOCUS_DEBOUNCE_MS);
    return focus.done;
  }

  /** One pass: policy, grab, dedupe, then hand the frame to OCR. Any failure keeps nothing. */
  private async cycle(): Promise<void> {
    const context = this.context;
    if (!this.running || this.grabbing || !context || !context.enabled) return;
    this.grabbing = true;
    const attempt = this.grabAndQueue(this.generation);
    this.cycling = attempt;
    try {
      await attempt;
    } finally {
      this.grabbing = false;
      if (this.cycling === attempt) this.cycling = undefined;
    }
  }

  private async grabAndQueue(generation: number): Promise<void> {
    try {
      // The secure input check also refreshes the app in front, so the frame is labelled with the app on screen now.
      const secureInput = await settleWithin(this.deps.secureInput(), CHECK_TIMEOUT_MS, 'unknown' as const);
      const current = this.context;
      if (generation !== this.generation || !current || !screenDecision({ ...current, secureInput }).capture) return;
      const frame = await settleWithin(this.deps.source.grab(), CHECK_TIMEOUT_MS, null);
      if (!frame || generation !== this.generation) return;
      // A repeat of the last kept frame costs no OCR and no storage. The fingerprint is kept even if the frame is later dropped.
      if (!this.deduper.shouldKeep(fingerprintBitmap(frame.bgra, frame.width, frame.height))) return;
      this.enqueue({ ts: this.deps.now(), context: current, png: frame.png, generation });
    } catch {
      // The error text is dropped on purpose. It can describe what was on screen.
    }
  }

  private enqueue(job: Job): void {
    this.pending = job;
    this.draining ??= this.drain();
  }

  private async drain(): Promise<void> {
    try {
      while (this.pending) {
        const job = this.pending;
        this.pending = null;
        await this.read(job).catch(() => undefined);
      }
    } finally {
      this.draining = undefined;
    }
  }

  private async read(job: Job): Promise<void> {
    const started = this.deps.now();
    let text: string;
    try {
      text = normaliseOcr(await this.deps.ocr.recognise(job.png));
    } catch {
      // A dropped frame must not stand as the reference for the next one, or an unchanged screen is never read again.
      this.deduper.reset();
      return;
    }
    this.recentReads.push(this.deps.now() - started);
    if (this.recentReads.length > RECENT_READS) this.recentReads.shift();
    // The frame passed its checks when it was taken. It is kept only if the state still allows it now, and a secure field
    // that took focus during OCR stops it.
    if (!(await this.stillAllowed(job))) {
      this.deduper.reset();
      return;
    }
    // A frame with no text cannot be found by search, so its image is not kept either.
    if (text === '') return;
    const mediaId = await this.keepImage(job.png);
    // Pause, stop, delete or a secure field can arrive while the image is written. They are checked again before the text
    // is stored, and an image that is no longer wanted is removed.
    if (!(await this.stillAllowed(job))) {
      this.deduper.reset();
      if (mediaId) await this.deps.media.remove([mediaId]).catch(() => undefined);
      return;
    }
    let stored = false;
    try {
      stored = this.deps.sink.ingestScreen({
        ts: job.ts,
        app: job.context.app,
        windowClass: job.context.windowClass,
        text,
        mediaId,
      });
    } catch {
      stored = false;
    }
    // An image whose text was not stored would be kept with nothing to find it by, so it is removed.
    if (!stored) {
      this.deduper.reset();
      if (mediaId) await this.deps.media.remove([mediaId]).catch(() => undefined);
    }
  }

  /**
   * True while the frame's capture generation is current, capture is running, and the policy allows a screen read now.
   * It runs the secure input check again, so a password field that took focus after the frame was grabbed stops the read.
   */
  private async stillAllowed(job: Job): Promise<boolean> {
    if (job.generation !== this.generation || !this.running) return false;
    const secureInput = await settleWithin(this.deps.secureInput(), CHECK_TIMEOUT_MS, 'unknown' as const);
    const current = this.context;
    return current !== null && screenDecision({ ...current, secureInput }).capture;
  }

  /** Seals the frame as an image and returns its id. A failed write returns null, and the text is still kept. */
  private async keepImage(png: Buffer): Promise<string | null> {
    const mediaId = newId();
    try {
      await this.deps.media.write(mediaId, encodeJpeg(png));
      return mediaId;
    } catch {
      return null;
    }
  }
}

/** The Electron grab of the primary display, at OCR_WIDTH or less. */
export function electronFrameSource(): FrameSource {
  return {
    async grab() {
      const display = screen.getPrimaryDisplay();
      const physicalWidth = Math.round(display.size.width * display.scaleFactor);
      const physicalHeight = Math.round(display.size.height * display.scaleFactor);
      const width = Math.min(OCR_WIDTH, physicalWidth);
      const height = Math.max(1, Math.round((physicalHeight * width) / physicalWidth));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      // Only the primary display is read. With several displays and no match, nothing is read.
      const sameDisplay = sources.find(candidate => candidate.display_id === String(display.id));
      const source = sameDisplay ?? (sources.length === 1 ? sources[0] : undefined);
      if (!source) return null;
      const { thumbnail } = source;
      const size = thumbnail.getSize();
      // Without screen recording permission the thumbnail comes back empty, and an empty frame is never kept.
      if (size.width < 1 || size.height < 1) return null;
      return { width: size.width, height: size.height, bgra: thumbnail.toBitmap(), png: thumbnail.toPNG() };
    },
  };
}

interface Waiting {
  resolve: (text: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Runs OCR in an Electron utility process, so reading a frame never blocks the main thread. One request is in flight at
 * a time. A request that takes too long ends the worker, and the next frame starts a fresh one.
 */
export function forkOcrWorker(workerPath: string): OcrEngine {
  let child: UtilityProcess | undefined;
  let nextId = 1;
  const waiting = new Map<number, Waiting>();

  const settle = (id: number, result: { text: string } | { error: Error }): void => {
    const entry = waiting.get(id);
    if (!entry) return;
    waiting.delete(id);
    clearTimeout(entry.timer);
    if ('text' in result) entry.resolve(result.text);
    else entry.reject(result.error);
  };

  const ensureChild = (): UtilityProcess => {
    if (child) return child;
    const started = utilityProcess.fork(workerPath, [], {
      serviceName: 'companyOS screen text',
      // The worker's output is dropped on purpose. It must never reach a log, because it can describe the screen.
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    started.on('message', (message: OcrResponse) => {
      if (message.type === 'text') settle(message.id, { text: message.text });
      else settle(message.id, { error: new Error(OCR_FAILED) });
    });
    started.once('exit', () => {
      if (child === started) child = undefined;
      for (const id of [...waiting.keys()]) settle(id, { error: new Error(OCR_FAILED) });
    });
    child = started;
    return started;
  };

  return {
    recognise(png: Buffer): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const id = nextId++;
        const worker = ensureChild();
        const timer = setTimeout(() => {
          settle(id, { error: new Error(OCR_FAILED) });
          worker.kill();
        }, OCR_TIMEOUT_MS);
        waiting.set(id, { resolve, reject, timer });
        const request: OcrRequest = { type: 'recognise', id, png };
        worker.postMessage(request);
      });
    },
  };
}
