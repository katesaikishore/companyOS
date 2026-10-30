import { bridgedBrowserOf, polledFocusApp, type BridgedBrowser } from './browser-request';

/**
 * How long a bridge visit keeps the poll out of the way for its browser. It is longer than one poll interval, so a
 * visit the bridge reports between two polls still counts for the second one.
 */
const BRIDGE_VISIT_WINDOW_MS = 5_000;

/**
 * Decides which front-app changes the capture poll records. While the browser bridge has a recent visit for Chrome
 * or Edge, the bridge records that visit and the poll leaves the browser out, so one visit counts once. Any other
 * change is recorded. A Chrome or Edge change the bridge has not reported is recorded on the poll after the first
 * one that sees it, so a late bridge visit still counts once.
 */
export class FrontAppTracker {
  /** The app the last change was recorded, or left to the bridge, for. A change is any other app. */
  private lastApp: string | undefined;
  /** A bridged browser that came to the front with no bridge visit yet. The poll waits one more look before it records it. */
  private waitingApp: string | undefined;
  private readonly bridgeVisits = new Map<BridgedBrowser, number>();

  /** Notes a visit the bridge reported for a browser at time ts. */
  noteBridgeVisit(browser: BridgedBrowser, ts: number): void {
    this.bridgeVisits.set(browser, ts);
  }

  /**
   * One poll of the front app at time ts. Returns the app to record as a focus, or undefined when this poll records nothing.
   * The poll's focus for a browser is dropped only while the bridge is running and has a recent visit for it.
   */
  observe(app: string, ts: number, bridgeRunning: boolean): string | undefined {
    if (app === this.lastApp) {
      this.waitingApp = undefined;
      return undefined;
    }

    const browser = bridgedBrowserOf(app);
    const reported = browser !== undefined && bridgeRunning && this.reportedRecently(browser, ts);
    // The bridge has this visit, so the poll drops its focus. lastApp still moves on, so a later return is seen.
    if (polledFocusApp(app, reported) === undefined) {
      this.lastApp = app;
      this.waitingApp = undefined;
      return undefined;
    }

    // The bridge's message can arrive after the poll that first sees the switch. A bridged browser gets one more look.
    if (browser !== undefined && bridgeRunning && this.waitingApp !== app) {
      this.waitingApp = app;
      return undefined;
    }

    this.lastApp = app;
    this.waitingApp = undefined;
    return app;
  }

  private reportedRecently(browser: BridgedBrowser, ts: number): boolean {
    const visit = this.bridgeVisits.get(browser);
    return visit !== undefined && ts - visit <= BRIDGE_VISIT_WINDOW_MS;
  }
}
