import {
  KeystrokeBuffer,
  keystrokeDecision,
  type FinishedText,
  type KeyEvent,
  type KeystrokeState,
} from '@companyos/twin-core';
import type { KeyboardSource } from './keyboard';

/**
 * Keeps typed text, as finished pieces, when the policy allows it. It sits between the keyboard source and the agent:
 *
 *   key press -> gate (policy, with a fresh secure-input reading) -> KeystrokeBuffer -> finished piece -> fresh check -> agent
 *
 * Nothing here reads a key's code or stores text. The buffer holds the open piece in memory only, and a piece is stored
 * once it ends. Every check fails closed: a reading that is unknown, a missing permission or a refused state drops the piece.
 *
 * The app in front is read again before a piece is kept, so a piece is filed under the app it was typed into. The app
 * switch that the capture poll reports (every few seconds) is the one case a piece can end across: it is kept only when the
 * app now in front is allowed. A switch the poll has not yet seen can still let a few keys into the wrong piece. That is the
 * known gap, and it is stated in the docs.
 */

/** How long a secure-input reading counts as current. An older reading is taken again before a key is kept. */
const SECURE_TTL_MS = 2_000;
/** How long the app in front counts as current for the first key of a piece. */
const FRONT_TTL_MS = 1_000;
/** Keys that arrive while a reading is under way wait for it. Past this many, the piece is dropped (see `gap`). */
const MAX_WAITING_KEYS = 256;
/** How often the pause is checked. */
const TICK_MS = 1_000;

export interface KeystrokeServiceDeps {
  source: KeyboardSource;
  /** The app in front, read now. Undefined when it cannot be named. */
  frontApp: () => Promise<string | undefined>;
  /** Secure input, read now. 'unknown' when the system cannot say. */
  secureInput: () => Promise<boolean | 'unknown'>;
  /** The policy's inputs for an app, from the settings and the capture holds. The secure-input reading is added here. */
  state: (app: string | undefined) => Omit<KeystrokeState, 'secureInput'>;
  /** Keeps one finished piece. Returns whether the store kept it. */
  ingest: (piece: { ts: number; app: string; text: string }) => boolean;
  now?: () => number;
}

/** Why a piece ended. A switch is the only one that may end across an app change. */
type Boundary = 'key' | 'pause' | 'switch';

/** The keys that end a piece by themselves. A gap is closed only by one of these. */
const ENDS_PIECE: ReadonlySet<KeyEvent['kind']> = new Set(['enter', 'tab', 'other', 'shortcut']);

export class KeystrokeService {
  private enabled = false;
  private readonly buffer = new KeystrokeBuffer();
  /** The app the open piece was started in. */
  private bufferApp: string | undefined;
  private front: string | undefined;
  private frontAt = Number.NEGATIVE_INFINITY;
  private secure: { value: boolean | 'unknown'; at: number } | undefined;
  private reading = false;
  private waiting: Array<{ event: KeyEvent; ts: number }> = [];
  /** Every discard changes this. A store that began before a discard sees the change, and keeps nothing. */
  private generation = 0;
  /**
   * Set when keys had to be dropped. Text is never assembled across a gap, since a dropped Backspace would keep a typo. The
   * keys after the gap are dropped too, until a key that ends a piece (Enter, Tab, another key that moves the caret, or a
   * shortcut) clears it.
   */
  private gap = false;
  private timer: NodeJS.Timeout | undefined;
  private readonly now: () => number;

  constructor(private readonly deps: KeystrokeServiceDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /** Whether this system has a keyboard hook at all. */
  get available(): boolean {
    return this.deps.source.available;
  }

  get unavailableReason(): string {
    return this.deps.source.unavailableReason;
  }

  /** Whether key presses are being delivered now. */
  get permissionGranted(): boolean {
    return this.deps.source.permissionGranted();
  }

  /** Starts or stops the source to match the setting. Turning it off drops whatever is held. */
  setEnabled(on: boolean): void {
    if (on === this.enabled) return;
    this.enabled = on;
    if (on) {
      try {
        this.deps.source.start(event => this.onKey(event));
      } catch {
        // No key is reported. The state says the hook is not running, and no detail is kept.
      }
      this.timer = setInterval(() => this.tick(), TICK_MS);
      this.timer.unref?.();
      return;
    }
    try {
      this.deps.source.stop();
    } catch {
      // The source is not running, so there is nothing more to stop.
    }
    clearInterval(this.timer);
    this.timer = undefined;
    this.gap = false;
    this.discard();
  }

  /** Stops the source and drops whatever is held. The app is closing. */
  stop(): void {
    this.setEnabled(false);
  }

  /**
   * Drops the open piece and any waiting key without keeping them. Used when the person deletes captured text. A piece that
   * is still being checked for storage is dropped too.
   */
  discard(): void {
    this.generation++;
    this.buffer.clear();
    this.bufferApp = undefined;
    this.waiting = [];
  }

  /** Drops the open piece and everything until the next key that ends a piece. Used when keys had to be dropped. */
  private openGap(): void {
    this.discard();
    this.gap = true;
  }

  /** Brings the held text in line with the policy now. A refused state drops the open piece. */
  refresh(): void {
    if (!keystrokeDecision(this.stateNow()).capture) this.discard();
  }

  /**
   * The app in front, as the capture poll reports it. A change ends the open piece. It is kept under the app it started in
   * only when the policy allows the app that is now in front, so a piece never ends across an excluded app.
   */
  noteFront(app: string | undefined): void {
    if (app === this.front) return;
    this.front = app;
    this.frontAt = this.now();
    if (!this.enabled || this.bufferApp === undefined) return;
    const piece = this.buffer.take(this.now());
    const startedIn = this.bufferApp;
    if (this.buffer.length === 0) this.bufferApp = undefined;
    if (piece) void this.store(piece, 'switch', startedIn);
  }

  /**
   * Called every second. Ends a piece after the pause, subject to the same checks as a key. Public so the privacy suite can
   * drive it without a timer.
   */
  tick(): void {
    if (!this.enabled || this.buffer.length === 0) return;
    if (!keystrokeDecision(this.stateNow()).capture) {
      this.discard();
      return;
    }
    const piece = this.buffer.poll(this.now());
    const startedIn = this.bufferApp;
    if (this.buffer.length === 0) this.bufferApp = undefined;
    if (piece && startedIn !== undefined) void this.store(piece, 'pause', startedIn);
  }

  private onKey(event: KeyEvent): void {
    if (!this.enabled || event.kind === 'modifier') return;
    if (this.gap) {
      // Only a key that ends a piece can close the gap. Nothing before it is kept, so nothing after it is joined to it.
      if (ENDS_PIECE.has(event.kind)) this.gap = false;
      return;
    }
    const ts = this.now();
    if (this.reading || this.waiting.length > 0 || !this.secureFresh(ts) || this.needsFront(event, ts)) {
      // A key waits for a reading, so no key is decided on an old one. Kept in order, and only in memory.
      if (this.waiting.length >= MAX_WAITING_KEYS) {
        this.waiting = [];
        this.openGap();
        return;
      }
      this.waiting.push({ event, ts });
      if (!this.reading) void this.read();
      return;
    }
    this.apply(event, ts);
  }

  /** Whether the first key of a piece needs the app in front read again. */
  private needsFront(event: KeyEvent, ts: number): boolean {
    return event.kind === 'text' && this.buffer.length === 0 && ts - this.frontAt >= FRONT_TTL_MS;
  }

  private secureFresh(ts: number): boolean {
    return this.secure !== undefined && ts - this.secure.at < SECURE_TTL_MS;
  }

  /** Reads the app in front and secure input, then decides the keys that waited for them. */
  private async read(): Promise<void> {
    this.reading = true;
    let front: string | undefined;
    let secure: boolean | 'unknown' = 'unknown';
    try {
      [front, secure] = await Promise.all([this.deps.frontApp(), this.deps.secureInput()]);
    } catch {
      // A failed read leaves the app unnamed and secure input unknown, so the policy refuses.
      front = undefined;
      secure = 'unknown';
    }
    const at = this.now();
    this.front = front;
    this.frontAt = at;
    this.secure = { value: secure, at };
    this.reading = false;
    this.drain();
  }

  private drain(): void {
    const waiting = this.waiting;
    this.waiting = [];
    if (!this.enabled) return;
    for (const { event, ts } of waiting) this.apply(event, ts);
  }

  /** Decides one key with the state as it is now, and feeds the buffer. */
  private apply(event: KeyEvent, ts: number): void {
    if (!keystrokeDecision(this.stateNow()).capture) {
      this.discard();
      return;
    }
    if (event.kind === 'text' && this.buffer.length === 0) this.bufferApp = this.front;
    const piece = this.buffer.push(event, ts);
    const startedIn = this.bufferApp;
    if (this.buffer.length === 0) this.bufferApp = undefined;
    if (piece && startedIn !== undefined) void this.store(piece, event.kind === 'shortcut' ? 'switch' : 'key', startedIn);
  }

  /**
   * Reads the app in front and secure input again, and keeps the piece only if the policy allows it now. A piece that ended
   * on a key or a pause must still be typed in the app it started in. A switch may end it across the change, but then the
   * policy has already checked the app now in front.
   */
  private async store(piece: FinishedText, boundary: Boundary, app: string): Promise<void> {
    // Taken before the first await, so a discard or a stop during the reads is seen below.
    const generation = this.generation;
    try {
      let front: string | undefined;
      let secure: boolean | 'unknown' = 'unknown';
      try {
        [front, secure] = await Promise.all([this.deps.frontApp(), this.deps.secureInput()]);
      } catch {
        front = undefined;
        secure = 'unknown';
      }
      const at = this.now();
      this.front = front;
      this.frontAt = at;
      this.secure = { value: secure, at };
      // The text was deleted or the service stopped while the reads ran, so the piece is not written.
      if (generation !== this.generation || !this.enabled) return;
      if (!keystrokeDecision({ ...this.deps.state(front), secureInput: secure }).capture) return;
      if (boundary !== 'switch' && front !== app) return;
      this.deps.ingest({ ts: piece.startedAt, app, text: piece.text });
    } catch {
      // The piece is dropped. The error text is not kept, since it could hold part of the text.
    }
  }

  private stateNow(): KeystrokeState {
    return { ...this.deps.state(this.front), secureInput: this.secure?.value ?? 'unknown' };
  }
}
