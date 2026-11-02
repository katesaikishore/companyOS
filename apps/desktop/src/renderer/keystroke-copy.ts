import type { CaptureChannelState } from '@companyos/twin-core';

/**
 * The wording of the typed-text switch in Settings. It says what is kept and when it is refused, so it must match the engine:
 * the policy in packages/core/src/capture-policy.ts (keystrokeDecision) and the retention in agent.ts. The renderer cannot
 * import those values, so test/keystroke-copy.test.ts checks the facts this copy states.
 */
export const KEYSTROKE_COPY = {
  label: 'Record typed text',
  /** The switch's note while the feature can run. */
  note:
    'Keeps the text you type into apps, as finished pieces, encrypted on this device. A piece ends when you press Enter or Tab, when the app in front changes, ' +
    'when you press a key that moves the cursor, or after five seconds with no key. It is kept for 90 days and searched on Recall. ' +
    'Only the US keyboard layout is read in this version, since the keys are read by position; on another layout the kept text would be wrong. ' +
    'On macOS, turning this on asks for Accessibility access in System Settings, and nothing is kept until it is allowed. ' +
    'Not kept: text typed into a browser; a shortcut with Command, Control or Option, which includes some characters typed on a Mac; an app or kind of window on the exclusion list; and anything while the screen is locked, ' +
    'capture is paused, or you are away. Passwords are refused where secure input is detected, and not every password field reports it, so turn this off before you type a password. ' +
    'A password field is checked for as you type and before each piece is saved, and a piece is refused when that check fails or cannot tell. ' +
    'Characters typed between two checks can still be kept. ' +
    'Card-like numbers and key-like tokens are replaced before saving. A password typed into an ordinary text box is not recognised.',
  /** The switch's note when this build or this system has no keyboard hook, so the switch cannot take effect. */
  unsupported:
    'Not available in this build. This version keeps typed text on macOS only, because only macOS can check for password fields, ' +
    'and the keyboard hook has to load there. No text is kept on this system.',
  /** The switch's note when the keyboard hook could not start, which on macOS usually means Accessibility access is not allowed. */
  needsPermission:
    'The keyboard hook could not start, so no typed text is kept. On macOS, allow companyOS under Accessibility in System Settings, ' +
    'then turn this off and on again.',
  /** The name of the delete control that removes typed text with the screen and audio text. */
  deleteLabel: 'Delete screen, audio and typed text',
} as const;

/** The switch's note for the channel state: the full note while it can run, and the reason when it cannot. */
export function keystrokeNote(state: CaptureChannelState): string {
  if (state === 'unsupported') return KEYSTROKE_COPY.unsupported;
  if (state === 'needs_permission') return KEYSTROKE_COPY.needsPermission;
  return KEYSTROKE_COPY.note;
}
