import { describe, expect, it } from 'vitest';
import { Pseudonymizer, classifyApp, isExcludedApp, normalizeAppName, normalizeSignal, templateUrl } from '../src';

const EXCLUDED = ['1password', 'bitwarden'];

describe('templateUrl', () => {
  it('keeps host and shape, replaces identifiers, drops query and fragment', () => {
    expect(templateUrl('https://docs.example.com/doc/1ab2cd3ef4567890/edit?token=abc#frag')).toBe(
      'docs.example.com/doc/:id/edit',
    );
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
  const options = { excludedApps: EXCLUDED, newId: () => 'e1' };

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
    expect(browser?.urlTemplate).toBe('a.example.com/x/:id');
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
