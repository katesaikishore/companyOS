import { mkdtempSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { TwinAgent, polledFocusApp, urlTemplate, type TwinEvent } from '../src';
import { at } from './fixtures';

const SECRET = 'SECRET123456';

/**
 * What the capture poll and the bridge send when the person switches to Chrome and opens a page. The poll names the
 * app the way the OS does (Linux reports google-chrome), and the poll's focus is dropped while the bridge has a recent visit.
 */
function switchToChrome(agent: TwinAgent, ts: number, rawUrl: string, polledName: string): void {
  const polled = polledFocusApp(polledName, true);
  if (polled) agent.ingest({ kind: 'focus', ts, app: polled });
  const template = urlTemplate(rawUrl);
  if (template) agent.ingest({ kind: 'focus', ts, app: 'Google Chrome', url: `https://${template}` });
}

function openAgent(watchBrowsers?: boolean): TwinAgent {
  const agent = new TwinAgent({ dataDir: mkdtempSync(join(tmpdir(), 'twin-browser-')), dataKey: randomBytes(32), now: () => at(0, 13) });
  if (watchBrowsers !== undefined) agent.updateConfig({ watchBrowsers });
  return agent;
}

/**
 * Feeds one browser visit the way the desktop bridge does: the browser's app name and the URL template,
 * never the full URL. Returns whatever the engine returned.
 */
function visit(agent: TwinAgent, app: string, rawUrl: string, extra: Record<string, unknown> = {}): boolean {
  const template = urlTemplate(rawUrl);
  return agent.ingest({ kind: 'focus', ts: at(0, 12), app, ...(template ? { url: `https://${template}` } : {}), ...extra });
}

function storedEvents(agent: TwinAgent): TwinEvent[] {
  return (agent.exportAll() as { events: TwinEvent[] }).events;
}

describe('browser visits in the engine', () => {
  it('stores the browser as the focused app with the URL template, and never the query or the fragment', () => {
    const agent = openAgent(true);
    expect(visit(agent, 'Google Chrome', `https://docs.example.com/doc/1ab2cd3?token=${SECRET}#top`)).toBe(true);

    const [event] = storedEvents(agent);
    expect(event).toMatchObject({ kind: 'focus', app: 'google chrome', windowClass: 'browser', urlTemplate: 'docs.example.com/doc' });

    const stored = JSON.stringify(agent.exportAll());
    expect(stored).not.toContain(SECRET);
    expect(stored).not.toContain('1ab2cd3');
    expect(stored).not.toContain('#top');
  });

  it('drops a visit from a private window and stores nothing for it', () => {
    const agent = openAgent(true);
    expect(visit(agent, 'Microsoft Edge', `https://private.example.com/x?${SECRET}`, { isPrivateWindow: true })).toBe(false);

    expect(storedEvents(agent)).toHaveLength(0);
    expect(JSON.stringify(agent.exportAll())).not.toContain('private.example.com');
  });

  it('keeps the normal visits around a private one, and drops only the private one', () => {
    const agent = openAgent(true);
    expect(visit(agent, 'Google Chrome', 'https://docs.example.com/doc/1ab2cd3')).toBe(true);
    expect(visit(agent, 'Google Chrome', 'https://private.example.com/doc/1ab2cd3', { isPrivateWindow: true })).toBe(false);
    expect(visit(agent, 'Microsoft Edge', 'https://wiki.example.com/page/9f8e7d6')).toBe(true);

    const events = storedEvents(agent);
    expect(events.map(event => event.urlTemplate)).toEqual(['docs.example.com/doc', 'wiki.example.com/page']);
  });

  it('drops every browser visit while browser capture is off, which is the default', () => {
    const agent = openAgent();
    expect(agent.configuration.watchBrowsers).toBe(false);
    expect(visit(agent, 'Google Chrome', 'https://docs.example.com/doc/1ab2cd3')).toBe(false);
    expect(storedEvents(agent)).toHaveLength(0);
  });

  it('stores only the app for a page with no web template, such as a browser settings page', () => {
    const agent = openAgent(true);
    expect(visit(agent, 'Google Chrome', 'chrome://settings/passwords')).toBe(true);

    const [event] = storedEvents(agent);
    expect(event?.app).toBe('google chrome');
    expect(event?.urlTemplate).toBeUndefined();
  });

  it('counts browser visits in per-app usage like other focus events', () => {
    const agent = openAgent(true);
    visit(agent, 'Google Chrome', 'https://docs.example.com/doc/1ab2cd3');
    visit(agent, 'Google Chrome', 'https://docs.example.com/doc/9f8e7d6');
    const chrome = agent.appUsage(7).find(usage => usage.app === 'google chrome');
    expect(chrome).toMatchObject({ windowClass: 'browser', events: 2 });
  });

  it('counts one visit once in per-app usage and in mined patterns while the bridge runs', () => {
    const agent = openAgent(true);
    for (let day = 0; day < 3; day++) {
      agent.ingest({ kind: 'focus', ts: at(day, 9), app: 'Slack' });
      switchToChrome(agent, at(day, 9, 10), 'https://docs.example.com/doc/1ab2cd3', 'google-chrome');
      agent.ingest({ kind: 'focus', ts: at(day, 9, 30), app: 'Slack' });
    }

    const browsers = agent.appUsage(7).filter(usage => usage.windowClass === 'browser');
    expect(browsers).toEqual([expect.objectContaining({ app: 'google chrome', events: 3 })]);

    const routine = agent.analyze().routines.find(candidate => candidate.steps.some(step => step.windowClass === 'browser'));
    expect(routine).toBeDefined();
    expect(routine?.steps[1]).toMatchObject({ app: 'google chrome', options: ['google chrome'] });
    expect(routine?.support).toBe(3);
  });
});
