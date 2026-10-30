import { describe, expect, it } from 'vitest';
import { resolveUpdateFeed, UPDATE_FEED_VARIABLE } from '../src/main/updater';

const withFeed = (value: string) => ({ [UPDATE_FEED_VARIABLE]: value });

describe('resolveUpdateFeed', () => {
  it('never updates an unpackaged build, even when a feed is set', () => {
    expect(resolveUpdateFeed(false, withFeed('https://updates.example.com/companyos'))).toEqual({
      enabled: false,
      reason: 'not-packaged',
    });
  });

  it('stays off in a packaged build with no feed, or a blank one', () => {
    expect(resolveUpdateFeed(true, {})).toEqual({ enabled: false, reason: 'no-feed' });
    expect(resolveUpdateFeed(true, withFeed('   '))).toEqual({ enabled: false, reason: 'no-feed' });
  });

  it('accepts an HTTPS feed and trims surrounding space', () => {
    expect(resolveUpdateFeed(true, withFeed('  https://updates.example.com/companyos/  '))).toEqual({
      enabled: true,
      feedUrl: 'https://updates.example.com/companyos/',
    });
  });

  it.each([
    ['plain HTTP', 'http://updates.example.com/companyos'],
    ['a file path', 'file:///Users/someone/feed'],
    ['not a URL', 'updates.example.com'],
    ['credentials in the URL', 'https://user:pass@updates.example.com/companyos'],
    ['a query string', 'https://updates.example.com/companyos?token=abc'],
  ])('rejects a feed with %s', (_label, value) => {
    expect(resolveUpdateFeed(true, withFeed(value))).toEqual({ enabled: false, reason: 'invalid-feed' });
  });
});
