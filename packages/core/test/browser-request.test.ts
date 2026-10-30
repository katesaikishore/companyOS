import { describe, expect, it } from 'vitest';
import {
  MAX_REQUEST_CHARS,
  MAX_SOCKET_PATH_BYTES,
  bridgedBrowserOf,
  parseVisitRequest,
  polledFocusApp,
  socketPathProblem,
  tokensMatch,
} from '../src';

const TOKEN = 'a'.repeat(64);
const VISIT = { type: 'visit', browser: 'chrome', template: 'docs.example.com/doc/:id', token: TOKEN };

function request(fields: Record<string, unknown>): string {
  return JSON.stringify({ ...VISIT, ...fields });
}

describe('parseVisitRequest', () => {
  it('accepts a visit from Chrome or Edge with a template and the token', () => {
    expect(parseVisitRequest(request({}))).toEqual({ browser: 'chrome', template: 'docs.example.com/doc/:id', token: TOKEN });
    expect(parseVisitRequest(request({ browser: 'edge', template: 'example.com' }))).toEqual({
      browser: 'edge',
      template: 'example.com',
      token: TOKEN,
    });
  });

  it('refuses any field it does not expect, so a URL or a title cannot ride along', () => {
    expect(parseVisitRequest(request({ url: 'https://docs.example.com/doc?token=SECRET123456' }))).toBeUndefined();
    expect(parseVisitRequest(request({ title: 'Quarterly plan' }))).toBeUndefined();
  });

  it('refuses a request with the wrong type, an unknown browser, or no browser', () => {
    expect(parseVisitRequest(request({ type: 'focus' }))).toBeUndefined();
    expect(parseVisitRequest(request({ browser: 'firefox' }))).toBeUndefined();
    expect(parseVisitRequest(request({ browser: 'Chrome' }))).toBeUndefined();
    expect(parseVisitRequest(JSON.stringify({ type: 'visit', template: 'example.com', token: TOKEN }))).toBeUndefined();
  });

  it('accepts only a host and up to four plain path segments as a template', () => {
    for (const template of ['example.com', 'a.b.example.com/doc', 'example.com/:id/:id', 'example.com/doc/:id/edit', 'example.com/a/b/c/d']) {
      expect(parseVisitRequest(request({ template }))?.template).toBe(template);
    }
    for (const template of [
      'docs.example.com/doc?x=1',
      'docs.example.com/doc#top',
      'user@example.com',
      'Example.com',
      'example.com/Doc',
      'example.com/ab cd',
      'example.com/abcdefghijklm',
      'a.example.com/a/b/c/d/e',
      '',
    ]) {
      expect(parseVisitRequest(request({ template }))).toBeUndefined();
    }
  });

  it('refuses a template over 300 characters, a token over 128, and a token that is not a string', () => {
    expect(parseVisitRequest(request({ template: 'a'.repeat(301) }))).toBeUndefined();
    expect(parseVisitRequest(request({ token: 'a'.repeat(129) }))).toBeUndefined();
    expect(parseVisitRequest(request({ token: 5 }))).toBeUndefined();
    expect(parseVisitRequest(request({ template: 42 }))).toBeUndefined();
  });

  it('refuses a line over the length limit, and anything that is not a JSON object', () => {
    expect(parseVisitRequest('x'.repeat(MAX_REQUEST_CHARS + 1))).toBeUndefined();
    for (const line of ['not json', '[]', 'null', '"visit"', '']) {
      expect(parseVisitRequest(line)).toBeUndefined();
    }
  });
});

describe('tokensMatch', () => {
  it('matches the same token and nothing else', () => {
    expect(tokensMatch(TOKEN, TOKEN)).toBe(true);
    expect(tokensMatch('b'.repeat(64), TOKEN)).toBe(false);
    expect(tokensMatch(TOKEN.slice(1), TOKEN)).toBe(false);
    expect(tokensMatch('', TOKEN)).toBe(false);
  });
});

describe('bridgedBrowserOf', () => {
  it('maps the names Chrome and Edge go by on each system to the bridged browser', () => {
    expect(bridgedBrowserOf('Google Chrome')).toBe('chrome');
    expect(bridgedBrowserOf('google-chrome')).toBe('chrome');
    expect(bridgedBrowserOf('chrome')).toBe('chrome');
    expect(bridgedBrowserOf('Microsoft Edge')).toBe('edge');
    expect(bridgedBrowserOf('msedge')).toBe('edge');
    expect(bridgedBrowserOf('Microsoft-edge')).toBe('edge');
  });

  it('returns nothing for other browsers and other apps', () => {
    expect(bridgedBrowserOf('Firefox')).toBeUndefined();
    expect(bridgedBrowserOf('Chromium')).toBeUndefined();
    expect(bridgedBrowserOf('Slack')).toBeUndefined();
  });
});

describe('polledFocusApp', () => {
  it('drops a polled focus for Chrome or Edge while the bridge runs, since the bridge reports those visits', () => {
    expect(polledFocusApp('Google Chrome', true)).toBeUndefined();
    expect(polledFocusApp('google-chrome', true)).toBeUndefined();
    expect(polledFocusApp('msedge', true)).toBeUndefined();
  });

  it('keeps every polled focus when the bridge is not running, so Chrome still counts by app name', () => {
    expect(polledFocusApp('Google Chrome', false)).toBe('Google Chrome');
    expect(polledFocusApp('msedge', false)).toBe('msedge');
  });

  it('keeps other apps and other browsers while the bridge runs, and passes nothing through as nothing', () => {
    expect(polledFocusApp('Slack', true)).toBe('Slack');
    expect(polledFocusApp('Firefox', true)).toBe('Firefox');
    expect(polledFocusApp(undefined, true)).toBeUndefined();
  });
});

describe('socketPathProblem', () => {
  it('accepts a path up to the byte limit', () => {
    expect(socketPathProblem(`/${'a'.repeat(MAX_SOCKET_PATH_BYTES - 1)}`)).toBeUndefined();
  });

  it('explains a path over the byte limit, counting bytes rather than characters', () => {
    const problem = socketPathProblem(`/${'a'.repeat(MAX_SOCKET_PATH_BYTES)}`);
    expect(problem).toContain(`${MAX_SOCKET_PATH_BYTES + 1} bytes`);
    expect(problem).toContain(`limit ${MAX_SOCKET_PATH_BYTES}`);
    expect(socketPathProblem(`/${'é'.repeat(50)}`)).toContain('101 bytes');
  });
});
