import { describe, expect, it } from 'vitest';
import { audioDecision, screenDecision, type AudioState, type ScreenState } from '../src/capture-policy';

const OPEN_SCREEN: ScreenState = {
  enabled: true,
  locked: false,
  paused: false,
  idle: false,
  appExcluded: false,
  windowClass: 'document',
  secureInput: false,
  permissionGranted: true,
};

const OPEN_AUDIO: AudioState = { enabled: true, locked: false, paused: false, idle: false, permissionGranted: true };

describe('screenDecision', () => {
  it('allows a read when every check passes', () => {
    expect(screenDecision(OPEN_SCREEN)).toEqual({ capture: true, reason: 'Screen capture is running.' });
  });

  it.each<[string, Partial<ScreenState>, string]>([
    ['the setting is off', { enabled: false }, 'Screen capture is off.'],
    ['the screen is locked', { locked: true }, 'The screen is locked.'],
    ['capture is paused', { paused: true }, 'Capture is paused.'],
    ['the computer is idle', { idle: true }, 'You are away, so nothing is read.'],
    ['permission is missing', { permissionGranted: false }, 'Screen recording permission is not granted.'],
    ['the app is excluded', { appExcluded: true }, 'This app is excluded from capture.'],
    [
      'the window is a browser',
      { windowClass: 'browser' },
      'Browser windows are not read, because private windows cannot be told apart.',
    ],
    ['secure input is on', { secureInput: true }, 'A password field may have focus, so the read is skipped.'],
    ['secure input cannot be checked', { secureInput: 'unknown' }, 'Secure input cannot be checked, so the read waits.'],
  ])('skips the read when %s', (_name, change, reason) => {
    expect(screenDecision({ ...OPEN_SCREEN, ...change })).toEqual({ capture: false, reason });
  });

  it('gives the first failing reason when several checks fail', () => {
    expect(screenDecision({ ...OPEN_SCREEN, enabled: false, locked: true }).reason).toBe('Screen capture is off.');
    expect(screenDecision({ ...OPEN_SCREEN, locked: true, secureInput: 'unknown' }).reason).toBe('The screen is locked.');
    expect(screenDecision({ ...OPEN_SCREEN, appExcluded: true, windowClass: 'browser' }).reason).toBe(
      'This app is excluded from capture.',
    );
  });

  it('treats an unknown secure input as a stop, never as a pass', () => {
    expect(screenDecision({ ...OPEN_SCREEN, secureInput: 'unknown' }).capture).toBe(false);
  });
});

describe('audioDecision', () => {
  it('allows a segment when every check passes', () => {
    expect(audioDecision(OPEN_AUDIO)).toEqual({ capture: true, reason: 'Microphone capture is running.' });
  });

  it.each<[string, Partial<AudioState>, string]>([
    ['the setting is off', { enabled: false }, 'Microphone capture is off.'],
    ['the screen is locked', { locked: true }, 'The screen is locked.'],
    ['capture is paused', { paused: true }, 'Capture is paused.'],
    ['the computer is idle', { idle: true }, 'You are away, so nothing is heard.'],
    ['permission is missing', { permissionGranted: false }, 'Microphone permission is not granted.'],
  ])('skips the segment when %s', (_name, change, reason) => {
    expect(audioDecision({ ...OPEN_AUDIO, ...change })).toEqual({ capture: false, reason });
  });
});
