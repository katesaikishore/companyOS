import type { WindowClass } from './types';

/**
 * Decides, before each read, whether screen or microphone capture may run. Pure: the caller works out each input from
 * the operating system and the twin's state, and acts on the answer. Every check fails closed. Unknown secure input, a
 * missing permission or a switched-off channel all stop the read.
 */

export interface ScreenState {
  /** The screen capture setting. Off until the person turns it on. */
  enabled: boolean;
  locked: boolean;
  paused: boolean;
  idle: boolean;
  /** The focused app is on the exclusion list. */
  appExcluded: boolean;
  /** The class of the focused window. A browser window is never captured. */
  windowClass: WindowClass;
  /** Whether a password or other secure field may hold focus. 'unknown' when the operating system cannot say. */
  secureInput: boolean | 'unknown';
  permissionGranted: boolean;
}

export interface AudioState {
  /** The microphone capture setting. Off until the person turns it on. */
  enabled: boolean;
  locked: boolean;
  paused: boolean;
  idle: boolean;
  permissionGranted: boolean;
}

export interface CaptureDecision {
  capture: boolean;
  /** A fixed sentence in plain words. It never contains captured content, so it is safe to show. */
  reason: string;
}

/** Whether one screen read may run. The first check that fails gives the reason. */
export function screenDecision(state: ScreenState): CaptureDecision {
  if (!state.enabled) return skip('Screen capture is off.');
  if (state.locked) return skip('The screen is locked.');
  if (state.paused) return skip('Capture is paused.');
  if (state.idle) return skip('You are away, so nothing is read.');
  if (!state.permissionGranted) return skip('Screen recording permission is not granted.');
  if (state.appExcluded) return skip('This app is excluded from capture.');
  if (state.windowClass === 'browser') return skip('Browser windows are not read, because private windows cannot be told apart.');
  if (state.secureInput === 'unknown') return skip('Secure input cannot be checked, so the read waits.');
  if (state.secureInput) return skip('A password field may have focus, so the read is skipped.');
  return { capture: true, reason: 'Screen capture is running.' };
}

/** Whether one microphone segment may be kept. The first check that fails gives the reason. */
export function audioDecision(state: AudioState): CaptureDecision {
  if (!state.enabled) return skip('Microphone capture is off.');
  if (state.locked) return skip('The screen is locked.');
  if (state.paused) return skip('Capture is paused.');
  if (state.idle) return skip('You are away, so nothing is heard.');
  if (!state.permissionGranted) return skip('Microphone permission is not granted.');
  return { capture: true, reason: 'Microphone capture is running.' };
}

function skip(reason: string): CaptureDecision {
  return { capture: false, reason };
}
