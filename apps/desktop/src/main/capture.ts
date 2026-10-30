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
  private locked = false;
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
    if (this.locked) return 'locked';
    if (this.paused) return 'paused';
    if (this.idle) return 'idle';
    return 'capturing';
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

  setLocked(locked: boolean): void {
    this.locked = locked;
    this.deps.agent.ingest({ kind: locked ? 'lock' : 'unlock', ts: this.now() });
  }

  /** The browser bridge reported a visit. The poll leaves that browser's change to the bridge while the visit is recent. */
  noteBridgeVisit(browser: BridgedBrowser): void {
    this.tracker.noteBridgeVisit(browser, this.now());
  }

  private async tick(): Promise<void> {
    const platform = this.deps.platform;
    if (!platform) return;

    // Pause and lock stop everything, including idle bookkeeping. Nothing is recorded while they are on.
    if (this.paused || this.locked) return;

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
    if (this.paused || this.locked || this.idle) return;
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
