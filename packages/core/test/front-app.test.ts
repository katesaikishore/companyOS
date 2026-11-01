import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FrontAppTracker, TwinAgent, urlTemplate, type TwinEvent } from '../src';
import { at } from './fixtures';
import { tempFolders } from './temp-folders';

const temps = tempFolders();

const CHROME = 'Google Chrome';
const SLACK = 'Slack';
const DOCS = 'https://docs.example.com/doc/1ab2cd3';

/** Seconds after 09:00 on the first day, so each poll and each bridge visit has a time the tests can read. */
function at9(seconds: number): number {
  return at(0, 9) + seconds * 1000;
}

function openAgent(): TwinAgent {
  const agent = temps.track(new TwinAgent({ dataDir: temps.folder('twin-front-app-'), dataKey: randomBytes(32), now: () => at(0, 13) }));
  agent.updateConfig({ watchBrowsers: true });
  return agent;
}

/** One capture poll. The tracker decides what is recorded, and the engine stores it the way the desktop does. */
function poll(agent: TwinAgent, tracker: FrontAppTracker, app: string, seconds: number, bridgeRunning = true): void {
  const recorded = tracker.observe(app, at9(seconds), bridgeRunning);
  if (recorded) agent.ingest({ kind: 'focus', ts: at9(seconds), app: recorded });
}

/** A visit the bridge reports: the browser, and the template of its active tab. The engine stores the template only. */
function bridgeVisit(agent: TwinAgent, tracker: FrontAppTracker, browser: 'chrome' | 'edge', app: string, rawUrl: string, seconds: number): void {
  tracker.noteBridgeVisit(browser, at9(seconds));
  const template = urlTemplate(rawUrl);
  agent.ingest({ kind: 'focus', ts: at9(seconds), app, ...(template ? { url: `https://${template}` } : {}) });
}

function storedEvents(agent: TwinAgent): TwinEvent[] {
  return (agent.exportAll() as { events: TwinEvent[] }).events;
}

function browserEvents(agent: TwinAgent): Array<Pick<TwinEvent, 'app' | 'urlTemplate'>> {
  return storedEvents(agent)
    .filter(event => event.windowClass === 'browser')
    .map(({ app, urlTemplate }) => ({ app, urlTemplate }));
}

describe('front-app changes in the capture poll', () => {
  it('records the return to the previous app after a browser visit the bridge reported', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    poll(agent, tracker, CHROME, 3);
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 3.2);
    poll(agent, tracker, CHROME, 6);
    poll(agent, tracker, SLACK, 9);

    expect(storedEvents(agent).map(({ app, windowClass, urlTemplate }) => ({ app, windowClass, urlTemplate }))).toEqual([
      { app: 'slack', windowClass: 'chat', urlTemplate: undefined },
      { app: 'google chrome', windowClass: 'browser', urlTemplate: 'docs.example.com/doc' },
      { app: 'slack', windowClass: 'chat', urlTemplate: undefined },
    ]);
  });

  it('records each return to a bridged browser, not only the first', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 2);
    poll(agent, tracker, CHROME, 3);
    poll(agent, tracker, SLACK, 6);
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 8);
    poll(agent, tracker, CHROME, 9);

    expect(browserEvents(agent)).toEqual([
      { app: 'google chrome', urlTemplate: 'docs.example.com/doc' },
      { app: 'google chrome', urlTemplate: 'docs.example.com/doc' },
    ]);
    expect(storedEvents(agent).map(event => event.app)).toEqual(['slack', 'google chrome', 'slack', 'google chrome']);
  });

  it('counts a visit the bridge reported once when the bridge reports before the poll sees it', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 2);
    poll(agent, tracker, CHROME, 3);
    poll(agent, tracker, CHROME, 6);

    expect(browserEvents(agent)).toEqual([{ app: 'google chrome', urlTemplate: 'docs.example.com/doc' }]);
    expect(agent.appUsage(7).find(usage => usage.app === 'google chrome')).toMatchObject({ events: 1 });
  });

  it('counts a visit the bridge reported once when the poll sees the switch before the bridge reports it', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    poll(agent, tracker, CHROME, 3);
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 3.5);
    poll(agent, tracker, CHROME, 6);
    poll(agent, tracker, CHROME, 9);

    expect(browserEvents(agent)).toEqual([{ app: 'google chrome', urlTemplate: 'docs.example.com/doc' }]);
  });

  it('counts an untracked browser page with no bridge visit through the poll', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    poll(agent, tracker, CHROME, 3);
    poll(agent, tracker, CHROME, 6);
    poll(agent, tracker, SLACK, 9);

    expect(storedEvents(agent).map(({ app, windowClass, urlTemplate }) => ({ app, windowClass, urlTemplate }))).toEqual([
      { app: 'slack', windowClass: 'chat', urlTemplate: undefined },
      { app: 'google chrome', windowClass: 'browser', urlTemplate: undefined },
      { app: 'slack', windowClass: 'chat', urlTemplate: undefined },
    ]);
  });

  it('lets the poll count a browser again once the last bridge visit is older than the window', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    bridgeVisit(agent, tracker, 'chrome', CHROME, DOCS, 0);
    poll(agent, tracker, CHROME, 1);
    poll(agent, tracker, SLACK, 3);
    poll(agent, tracker, CHROME, 9);
    poll(agent, tracker, CHROME, 12);

    expect(storedEvents(agent).map(event => event.app)).toEqual(['google chrome', 'slack', 'google chrome']);
    expect(browserEvents(agent)).toEqual([
      { app: 'google chrome', urlTemplate: 'docs.example.com/doc' },
      { app: 'google chrome', urlTemplate: undefined },
    ]);
  });

  it('records a browser at the first poll while the bridge is not running, as before the bridge existed', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0, false);
    poll(agent, tracker, CHROME, 3, false);

    expect(storedEvents(agent).map(event => event.app)).toEqual(['slack', 'google chrome']);
  });

  it('records nothing for a browser the front app left again before the second look', () => {
    const agent = openAgent();
    const tracker = new FrontAppTracker();
    poll(agent, tracker, SLACK, 0);
    poll(agent, tracker, CHROME, 3);
    poll(agent, tracker, SLACK, 6);

    expect(storedEvents(agent).map(event => event.app)).toEqual(['slack']);
  });
});
