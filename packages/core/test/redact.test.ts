import { describe, expect, it } from 'vitest';
import { Pseudonymizer, classifyApp, isExcludedApp, normalizeAppName, normalizeSignal, templateUrl } from '../src';

const EXCLUDED = ['1password', 'bitwarden'];

describe('templateUrl', () => {
  it('keeps the host and the first path word, and drops everything else', () => {
    expect(templateUrl('https://docs.example.com/doc/1ab2cd3ef4567890/edit?token=abc#frag')).toBe('docs.example.com/doc');
  });

  it('does not keep later segments that carry names, titles or ids', () => {
    expect(templateUrl('https://www.linkedin.com/in/jane-doe')).toBe('www.linkedin.com/in');
    expect(templateUrl('https://acme.atlassian.net/wiki/spaces/HR/pages/98765/Terminating+John+Smith')).toBe(
      'acme.atlassian.net/wiki',
    );
    expect(templateUrl('https://example.com/42/Jane-Doe')).toBe('example.com/:id');
  });

  it('rejects non-web schemes and malformed input', () => {
    expect(templateUrl('file:///Users/someone/secret.txt')).toBeUndefined();
    expect(templateUrl('not a url')).toBeUndefined();
  });
});

describe('app classification', () => {
  it('normalises names from macOS, Windows and Linux', () => {
    expect(normalizeAppName('Microsoft Excel.app')).toBe('microsoft excel');
    expect(normalizeAppName('EXCEL.EXE')).toBe('excel');
    expect(normalizeAppName('  Google   Chrome ')).toBe('google chrome');
  });

  it('classifies known apps and falls back to other', () => {
    expect(classifyApp('Microsoft Excel')).toBe('spreadsheet');
    expect(classifyApp('msedge')).toBe('browser');
    expect(classifyApp('Slack')).toBe('chat');
    expect(classifyApp('Some Unknown Tool')).toBe('other');
  });

  it('matches exclusions by substring on the normalised name', () => {
    expect(isExcludedApp('1Password 8', EXCLUDED)).toBe(true);
    expect(isExcludedApp('Microsoft Excel', EXCLUDED)).toBe(false);
  });
});

describe('normalizeSignal', () => {
  const options = { excludedApps: EXCLUDED, watchBrowsers: true, newId: () => 'e1' };

  it('stores a focus event with class and no raw titles', () => {
    const event = normalizeSignal({ kind: 'focus', ts: 1, app: 'Slack' }, options);
    expect(event).toEqual({ id: 'e1', ts: 1, kind: 'focus', app: 'slack', windowClass: 'chat' });
  });

  it('drops secure input, private windows and excluded apps', () => {
    expect(normalizeSignal({ kind: 'focus', ts: 1, app: 'Slack', secureInput: true }, options)).toBeNull();
    expect(normalizeSignal({ kind: 'focus', ts: 1, app: 'Chrome', isPrivateWindow: true }, options)).toBeNull();
    expect(normalizeSignal({ kind: 'focus', ts: 1, app: '1Password' }, options)).toBeNull();
  });

  it('rejects any field it should not receive, such as a window title', () => {
    expect(() => normalizeSignal({ kind: 'focus', ts: 1, app: 'Slack', title: 'Salary review' }, options)).toThrow();
  });

  it('keeps only the URL template and only for browsers', () => {
    const browser = normalizeSignal(
      { kind: 'focus', ts: 1, app: 'Chrome', url: 'https://a.example.com/x/1ab2cd3ef4567890?q=secret' },
      options,
    );
    expect(browser?.urlTemplate).toBe('a.example.com/x');
    const notBrowser = normalizeSignal(
      { kind: 'focus', ts: 1, app: 'Slack', url: 'https://a.example.com/x' },
      options,
    );
    expect(notBrowser?.urlTemplate).toBeUndefined();
  });
});

describe('Pseudonymizer', () => {
  it('is deterministic for one key and different across keys', () => {
    const a = new Pseudonymizer(Buffer.alloc(32, 1));
    const b = new Pseudonymizer(Buffer.alloc(32, 2));
    expect(a.token('app', 'slack')).toBe(a.token('app', 'slack'));
    expect(a.token('app', 'slack')).not.toBe(b.token('app', 'slack'));
    expect(a.token('app', 'slack')).toMatch(/^app_[A-Za-z0-9_-]{12}$/);
  });
});

describe('exclusions match every name an app is known by', () => {
  it('matches the display name a person types against the process name the OS reports', () => {
    expect(isExcludedApp('msedge', ['Microsoft Edge'])).toBe(true);
    expect(isExcludedApp('google-chrome', ['Google Chrome'])).toBe(true);
  });

  it('does not let a short name swallow unrelated apps', () => {
    expect(isExcludedApp('knowledge base', ['edge'])).toBe(false);
  });
});

describe('browser capture is opt-in', () => {
  it('drops browser focus unless browsers are watched', () => {
    const off = normalizeSignal({ kind: 'focus', ts: 1, app: 'Google Chrome' }, { excludedApps: [], watchBrowsers: false });
    expect(off).toBeNull();
  });

  it('drops focus from a browser the catalogue does not list, unless browsers are watched', () => {
    for (const app of ['Vivaldi', 'Arc', 'Opera GX', 'DuckDuckGo', 'Brave-browser']) {
      expect(normalizeSignal({ kind: 'focus', ts: 1, app }, { excludedApps: [], watchBrowsers: false })).toBeNull();
      expect(normalizeSignal({ kind: 'focus', ts: 1, app }, { excludedApps: [], watchBrowsers: true })).not.toBeNull();
    }
  });
});
