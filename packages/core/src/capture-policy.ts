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
  /** The focused window's class is on the window-class exclusion list. Undefined counts as not excluded. */
  windowExcluded?: boolean;
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
  if (state.windowExcluded) return skip('This kind of window is excluded from capture.');
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

/**
 * The inputs to one decision about typed text. The app is the one the text is typed into: the app in front, or the app the
 * text was started in when a switch has not been seen yet. An app that cannot be named counts as excluded.
 */
export interface KeystrokeState {
  /** The typed-text setting. Off until the person turns it on. */
  enabled: boolean;
  locked: boolean;
  paused: boolean;
  idle: boolean;
  /** Keyboard access is in place, so key presses are being delivered. */
  permissionGranted: boolean;
  appExcluded: boolean;
  /** The class of the window's kind is on the window-class exclusion list. */
  windowExcluded?: boolean;
  windowClass: WindowClass;
  /** Whether a password or other secure field may hold focus. 'unknown' when the operating system cannot say. */
  secureInput: boolean | 'unknown';
}

/**
 * Whether typed text may be kept now. Every check fails closed: unknown secure input, a missing permission or a switched-off
 * setting each stop it. The first check that fails gives the reason. A browser window is refused, since its private windows
 * cannot be told apart, as for screen text.
 */
export function keystrokeDecision(state: KeystrokeState): CaptureDecision {
  if (!state.enabled) return skip('Typed text capture is off.');
  if (state.locked) return skip('The screen is locked.');
  if (state.paused) return skip('Capture is paused.');
  if (state.idle) return skip('You are away, so no typed text is kept.');
  if (!state.permissionGranted) return skip('Keyboard access for typed text is not granted.');
  if (state.appExcluded) return skip('This app is excluded from capture.');
  if (state.windowExcluded) return skip('This kind of window is excluded from capture.');
  if (state.windowClass === 'browser') return skip('Browser windows are not read, because private windows cannot be told apart.');
  if (state.secureInput === 'unknown') return skip('Secure input cannot be checked, so typed text is not kept.');
  if (state.secureInput) return skip('A password field may have focus, so typed text is not kept.');
  return { capture: true, reason: 'Typed text capture is running.' };
}

function skip(reason: string): CaptureDecision {
  return { capture: false, reason };
}
