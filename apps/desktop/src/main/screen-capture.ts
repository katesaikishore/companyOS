import {
  FrameDeduper,
  fingerprintBitmap,
  newId,
  normaliseOcr,
  screenDecision,
  type ScreenRead,
  type ScreenState,
} from '@companyos/twin-core';
import { desktopCapturer, nativeImage, screen } from 'electron';
import type { MediaStore } from './media-store';

/**
 * Takes still frames of every display, one at a time, while screen capture is on. A frame passes the policy, is skipped when it
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
const PRIMARY_DISPLAY = 'primary';
const OCR_FAILED = 'The frame could not be read.';

export interface Frame {
  /** The display the frame shows. Frames of different displays are never compared with each other. Undefined means the primary display. */
  display?: string;
  width: number;
  height: number;
  /** The raw pixels, used only to tell two frames apart. The byte order does not matter for that. */
  bgra: Buffer;
  /** The frame as PNG at OCR_WIDTH. OCR reads it, and it is not kept. */
  png: Buffer;
}

export interface FrameSource {
  /** Grabs the next display in turn. Null when nothing can be grabbed, for example without screen recording permission. */
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

type FrameReason = 'focus' | 'interval';

interface ScreenCaptureDeps {
  source: FrameSource;
  ocr: OcrEngine;
  media: Pick<MediaStore, 'write' | 'remove'>;
  sink: { ingestScreen(read: ScreenRead): boolean };
  now: () => number;
  /** Whether a secure field may hold focus. Rejecting counts as unknown, so the frame is skipped. */
  secureInput: () => Promise<boolean | 'unknown'>;
  /** The text the focused window exposes to accessibility tools. Read with the OCR text, not instead of it. Empty when none. */
  accessibility?: () => Promise<string>;
  /** The app in front now, as the agent names it, or null when unknown. Accessibility text is kept only for the frame's own app. */
  frontApp?: () => Promise<string | null>;
}

interface Job {
  ts: number;
  context: ScreenContext;
  png: Buffer;
  /** The display the frame shows. */
  display: string;
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
  /** The last kept frame of each display. Displays do not repeat each other, so each keeps its own. */
  private dedupers = new Map<string, FrameDeduper>();
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
    this.dedupers.clear();
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
      const display = frame.display ?? PRIMARY_DISPLAY;
      if (!this.dedupeFor(display).shouldKeep(fingerprintBitmap(frame.bgra, frame.width, frame.height))) return;
      this.enqueue({ ts: this.deps.now(), context: current, png: frame.png, generation, display });
    } catch {
      // The error text is dropped on purpose. It can describe what was on screen.
    }
  }

  private dedupeFor(display: string): FrameDeduper {
    let deduper = this.dedupers.get(display);
    if (!deduper) {
      deduper = new FrameDeduper();
      this.dedupers.set(display, deduper);
    }
    return deduper;
  }

  private enqueue(job: Job): void {
    const replaced = this.pending;
    // A replaced frame from another display is never read or stored. Its fingerprint must not stay as that display's
    // reference, or the same unchanged screen is skipped there until it changes. A same-display frame supersedes it.
    if (replaced && replaced.display !== job.display) this.dedupeFor(replaced.display).reset();
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
      const ocrText = await this.deps.ocr.recognise(job.png);
      // Read before the checks below, so a secure field that takes focus during this read is caught by them.
      const accessible = await this.accessibleTextOf(job);
      text = normaliseOcr([accessible, ocrText].join('\n'));
    } catch {
      // A dropped frame must not stand as the reference for the next one, or an unchanged screen is never read again.
      this.dedupeFor(job.display).reset();
      return;
    }
    this.recentReads.push(this.deps.now() - started);
    if (this.recentReads.length > RECENT_READS) this.recentReads.shift();
    // The frame passed its checks when it was taken. It is kept only if the state still allows it now, and a secure field
    // that took focus during OCR stops it.
    if (!(await this.stillAllowed(job))) {
      this.dedupeFor(job.display).reset();
      return;
    }
    // A frame with no text cannot be found by search, so its image is not kept either.
    if (text === '') return;
    const mediaId = await this.keepImage(job.png);
    // Pause, stop, delete or a secure field can arrive while the image is written. They are checked again before the text
    // is stored, and an image that is no longer wanted is removed.
    if (!(await this.stillAllowed(job))) {
      this.dedupeFor(job.display).reset();
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
      this.dedupeFor(job.display).reset();
      if (mediaId) await this.deps.media.remove([mediaId]).catch(() => undefined);
    }
  }

  /**
   * The accessibility text of the window in front. The reader runs after the grab, so the window may have changed by now.
   * The text is kept only when the app in front is still the frame's own app, so one app's text is never filed under
   * another app's label. The OCR text of the frame is kept either way.
   */
  private async accessibleTextOf(job: Job): Promise<string> {
    if (!this.deps.accessibility || !this.deps.frontApp) return '';
    const text = await settleWithin(this.deps.accessibility(), CHECK_TIMEOUT_MS, '');
    const front = await settleWithin(this.deps.frontApp(), CHECK_TIMEOUT_MS, null);
    return front !== null && front === job.context.app ? text : '';
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

/** The Electron grab of each display in turn, at OCR_WIDTH or less. */
/** The displays are read one at a time, in turn. A single-display machine reads its one display, as before. */
export function electronFrameSource(): FrameSource {
  let turn = 0;
  return {
    async grab() {
      const displays = screen.getAllDisplays();
      if (displays.length === 0) return null;
      const display = displays[turn % displays.length];
      turn = (turn + 1) % displays.length;
      const physicalWidth = Math.round(display.size.width * display.scaleFactor);
      const physicalHeight = Math.round(display.size.height * display.scaleFactor);
      const width = Math.min(OCR_WIDTH, physicalWidth);
      const height = Math.max(1, Math.round((physicalHeight * width) / physicalWidth));
      const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width, height } });
      // Each display is read through its own source. A display with no matching source is not read. The one-source fallback
      // is for a single-display machine only: with two displays it would hand one display's pixels to the other.
      const sameDisplay = sources.find(candidate => candidate.display_id === String(display.id));
      const source = sameDisplay ?? (displays.length === 1 && sources.length === 1 ? sources[0] : undefined);
      if (!source) return null;
      const { thumbnail } = source;
      const size = thumbnail.getSize();
      // Without screen recording permission the thumbnail comes back empty, and an empty frame is never kept.
      if (size.width < 1 || size.height < 1) return null;
      return { display: String(display.id), width: size.width, height: size.height, bgra: thumbnail.toBitmap(), png: thumbnail.toPNG() };
    },
  };
}
