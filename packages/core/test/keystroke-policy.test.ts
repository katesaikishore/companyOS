import { describe, expect, it } from 'vitest';
import { keystrokeDecision, type KeystrokeState } from '../src/capture-policy';

const OPEN: KeystrokeState = {
  enabled: true,
  locked: false,
  paused: false,
  idle: false,
  permissionGranted: true,
  appExcluded: false,
  windowExcluded: false,
  windowClass: 'document',
  secureInput: false,
};

describe('keystrokeDecision', () => {
  it('keeps typed text when every check passes', () => {
    expect(keystrokeDecision(OPEN)).toEqual({ capture: true, reason: 'Typed text capture is running.' });
  });

  it.each<[string, Partial<KeystrokeState>, string]>([
    ['the setting is off', { enabled: false }, 'Typed text capture is off.'],
    ['the screen is locked', { locked: true }, 'The screen is locked.'],
    ['capture is paused', { paused: true }, 'Capture is paused.'],
    ['the person is idle', { idle: true }, 'You are away, so no typed text is kept.'],
    ['keyboard access is missing', { permissionGranted: false }, 'Keyboard access for typed text is not granted.'],
    ['the app is excluded', { appExcluded: true }, 'This app is excluded from capture.'],
    ['the window kind is excluded', { windowExcluded: true }, 'This kind of window is excluded from capture.'],
    [
      'the window is a browser',
      { windowClass: 'browser' },
      'Browser windows are not read, because private windows cannot be told apart.',
    ],
    ['secure input is on', { secureInput: true }, 'A password field may have focus, so typed text is not kept.'],
    ['secure input cannot be checked', { secureInput: 'unknown' }, 'Secure input cannot be checked, so typed text is not kept.'],
  ])('refuses when %s', (_name, change, reason) => {
    expect(keystrokeDecision({ ...OPEN, ...change })).toEqual({ capture: false, reason });
  });

  it('refuses an unknown secure-input state even when everything else passes', () => {
    expect(keystrokeDecision({ ...OPEN, secureInput: 'unknown' }).capture).toBe(false);
  });

  it('gives the first failing reason when several checks fail', () => {
    expect(keystrokeDecision({ ...OPEN, enabled: false, locked: true }).reason).toBe('Typed text capture is off.');
    expect(keystrokeDecision({ ...OPEN, locked: true, secureInput: 'unknown' }).reason).toBe('The screen is locked.');
    expect(keystrokeDecision({ ...OPEN, appExcluded: true, windowClass: 'browser' }).reason).toBe(
      'This app is excluded from capture.',
    );
  });

  it('treats the excluded-window flag as absent when it is not given', () => {
    const { windowExcluded: _omitted, ...withoutFlag } = OPEN;
    expect(keystrokeDecision(withoutFlag).capture).toBe(true);
  });
});
