import { describe, expect, it } from 'vitest';
import { CAPTURE_SOURCES, captureUrl, isSystemCaptureUrl } from '../src/main/capture-source';

describe('capture sources', () => {
  it('has a microphone source and a system source', () => {
    expect([...CAPTURE_SOURCES]).toEqual(['microphone', 'system']);
  });

  it('gives each source its own page address', () => {
    expect(captureUrl('microphone')).not.toBe(captureUrl('system'));
    expect(captureUrl('system')).toMatch(/capture\.html\?source=system$/);
  });

  it('recognises only the system page as the system page', () => {
    expect(isSystemCaptureUrl(captureUrl('system'))).toBe(true);
    expect(isSystemCaptureUrl(captureUrl('microphone'))).toBe(false);
    expect(isSystemCaptureUrl('app://twin/capture.html?source=system&x=1')).toBe(false);
    expect(isSystemCaptureUrl('https://example.com/capture.html?source=system')).toBe(false);
  });
});
