import { FrontAppTracker, type BridgedBrowser, type TwinAgent } from '@companyos/twin-core';
import type { Platform } from './platform';

export type CaptureState = 'capturing' | 'paused' | 'idle' | 'locked' | 'unsupported';

export interface CaptureDeps {
  agent: TwinAgent;
  platform: Platform | undefined;
  /** Called for each focus change the agent kept (not dropped by redaction). */
  onFocus?: (app: string) => void;
  /** Seconds since the last keyboard or mouse input, from the OS. */
  idleSeconds: () => number;
  /** Whether the browser bridge is running. While it is, a Chrome or Edge change waits for the bridge's visit. */
  bridgeRunning: () => boolean;
  now?: () => number;
}

/** Seconds without input after which the person counts as away. Dwell time alone is not idleness. */
const IDLE_THRESHOLD_SECONDS = 300;

/**
 * Turns OS observations into raw signals and hands them to the agent. The agent does the redaction.
 * This class sees app names and idle time only. It never sees titles, URLs or content.
 */
export class CaptureService {
  private timer: NodeJS.Timeout | undefined;
  private paused = false;
  /**
   * The screen's lock state. It starts unknown, and stays unknown until the operating system says or a lock event arrives.
   * Screen and microphone reads treat unknown as locked (see holds). The app-switch log stops only for a known lock, so a
   * system that cannot report the lock still records app switches, as it did before the lock was known.
   */
  private lock: 'locked' | 'unlocked' | 'unknown' = 'unknown';
  private idle = false;
  private readonly tracker = new FrontAppTracker();
  private detail: string;
  private readonly now: () => number;

  constructor(private readonly deps: CaptureDeps, detail: string) {
    this.now = deps.now ?? (() => Date.now());
    this.detail = detail;
  }

  get state(): CaptureState {
    if (!this.deps.platform) return 'unsupported';
    if (this.lock === 'locked') return 'locked';
    if (this.paused) return 'paused';
    if (this.idle) return 'idle';
    return 'capturing';
  }

  /**
   * The holds on screen and microphone capture. Unknown lock state counts as locked, so nothing is read before the screen's
   * state is known. The app-switch log is not held by it.
   */
  holds(): { locked: boolean; paused: boolean; idle: boolean } {
    return { locked: this.lock !== 'unlocked', paused: this.paused, idle: this.idle };
  }

  /** A lock the operating system or an event has reported. Unknown is not a lock here, see the note on the lock field. */
  private knownLocked(): boolean {
    return this.lock === 'locked';
  }

  /** Whether the lock state is known yet. */
  get lockKnown(): boolean {
    return this.lock !== 'unknown';
  }

  get status(): { state: CaptureState; detail: string } {
    return { state: this.state, detail: this.detail };
  }

  start(): void {
    if (this.timer || !this.deps.platform) return;
    this.timer = setInterval(() => void this.tick(), this.deps.platform.pollMs);
    void this.tick();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
  }

  /** A lock or unlock event from the operating system. It is recorded in the activity log. */
  setLocked(locked: boolean): void {
    this.lock = locked ? 'locked' : 'unlocked';
    this.deps.agent.ingest({ kind: locked ? 'lock' : 'unlock', ts: this.now() });
  }

  /**
   * The lock state read from the operating system at start, or on a later check while it is still unknown. It is not recorded
   * as an event, since no change was seen. It does nothing once the state is known, so a stale read cannot overwrite an event.
   */
  learnLock(locked: boolean): void {
    if (this.lock !== 'unknown') return;
    this.lock = locked ? 'locked' : 'unlocked';
  }

  /** The browser bridge reported a visit. The poll leaves that browser's change to the bridge while the visit is recent. */
  noteBridgeVisit(browser: BridgedBrowser): void {
    this.tracker.noteBridgeVisit(browser, this.now());
  }

  private async tick(): Promise<void> {
    const platform = this.deps.platform;
    if (!platform) return;

    // Pause and a known lock stop everything, including idle bookkeeping. Nothing is recorded while they are on.
    if (this.paused || this.knownLocked()) return;

    const ts = this.now();
    const idle = this.deps.idleSeconds() >= IDLE_THRESHOLD_SECONDS;
    if (idle !== this.idle) {
      this.idle = idle;
      this.deps.agent.ingest({ kind: idle ? 'idle_start' : 'idle_end', ts });
    }
    if (this.idle) return;

    let app: string | undefined;
    try {
      app = await platform.frontmost();
      this.detail = `Watching through ${platform.name}`;
    } catch {
      this.detail = 'Could not read the active app. Retrying.';
      return;
    }
    // The poll can take a second, so the state may have changed while it ran. Check again before storing.
    if (this.paused || this.knownLocked() || this.idle) return;
    if (!app || isOwnApp(app)) return;

    const recorded = this.tracker.observe(app, ts, this.deps.bridgeRunning());
    if (!recorded) return;
    if (this.deps.agent.ingest({ kind: 'focus', ts, app: recorded })) this.deps.onFocus?.(recorded);
  }
}

function isOwnApp(app: string): boolean {
  const name = app.toLowerCase();
  return name.includes('companyos') || name === 'electron';
}
