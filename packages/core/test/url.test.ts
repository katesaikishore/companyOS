import { describe, expect, it } from 'vitest';
import { urlTemplate } from '../src';

describe('urlTemplate', () => {
  it('keeps the host and plain path words, and turns id-like segments into :id', () => {
    expect(urlTemplate('https://docs.example.com/doc/1ab2cd3ef4567890/edit')).toBe('docs.example.com/doc/:id/edit');
    expect(urlTemplate('https://example.com/42/wiki')).toBe('example.com/:id/wiki');
  });

  it('drops the query string and the fragment, so no query value can leak', () => {
    const template = urlTemplate('https://docs.example.com/doc/1ab2cd3?token=SECRET123456&next=/x#section-2');
    expect(template).toBe('docs.example.com/doc/:id');
    expect(template).not.toContain('SECRET');
    expect(template).not.toContain('?');
    expect(template).not.toContain('#');
  });

  it('drops user information and the port', () => {
    expect(urlTemplate('https://user:password@Example.COM:8443/a/b')).toBe('example.com/a/b');
  });

  it('replaces slugs that may carry a name or a title with :id', () => {
    expect(urlTemplate('https://www.linkedin.com/in/jane-doe')).toBe('www.linkedin.com/in/:id');
    expect(urlTemplate('https://acme.example.net/wiki/Terminating+John+Smith')).toBe('acme.example.net/wiki/:id');
    expect(urlTemplate('https://example.com/search%20terms')).toBe('example.com/:id');
  });

  it('replaces UUIDs, dates and hashes with :id', () => {
    expect(urlTemplate('https://app.example.com/items/550e8400-e29b-41d4-a716-446655440000')).toBe(
      'app.example.com/items/:id',
    );
    expect(urlTemplate('https://example.com/reports/2026-10-30')).toBe('example.com/reports/:id');
    expect(urlTemplate('https://example.com/commit/9fceb02d0ae598e95dc970b74767f19372d61af8')).toBe(
      'example.com/commit/:id',
    );
  });

  it('keeps the host alone for a root URL and ignores a trailing slash', () => {
    expect(urlTemplate('https://example.com/')).toBe('example.com');
    expect(urlTemplate('http://example.com')).toBe('example.com');
    expect(urlTemplate('https://example.com/docs/')).toBe('example.com/docs');
  });

  it('stops after four path segments', () => {
    expect(urlTemplate('https://a.example.com/a/b/c/d/e/f')).toBe('a.example.com/a/b/c/d');
  });

  it('returns nothing for browser pages, local files and other schemes', () => {
    expect(urlTemplate('chrome://settings/passwords')).toBeUndefined();
    expect(urlTemplate('edge://downloads/all')).toBeUndefined();
    expect(urlTemplate('about:blank')).toBeUndefined();
    expect(urlTemplate('file:///Users/someone/secret.txt')).toBeUndefined();
    expect(urlTemplate('javascript:alert(1)')).toBeUndefined();
  });

  it('returns nothing for input that does not parse as a URL', () => {
    expect(urlTemplate('')).toBeUndefined();
    expect(urlTemplate('not a url')).toBeUndefined();
    expect(urlTemplate('https://')).toBeUndefined();
  });

  it('never returns a template that contains a credential marker or a query marker', () => {
    const samples = [
      'https://a.example.com/x/y?code=1',
      'https://u:p@b.example.com/z#frag',
      'https://c.example.com/@someone/profile',
    ];
    for (const sample of samples) {
      const template = urlTemplate(sample) ?? '';
      expect(template).not.toMatch(/[?#@]/);
      expect(template).not.toContain('password');
    }
  });
});
