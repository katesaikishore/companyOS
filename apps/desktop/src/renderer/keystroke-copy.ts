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
    'Keeps the text you type into apps, as finished pieces. A piece ends when you press Enter or Tab, when the app in front changes, ' +
    'when you press a key that moves the cursor, or after five seconds with no key. It is kept for 90 days, encrypted on this device, and searched on Recall. ' +
    'Not kept: text typed into a browser; a shortcut with Command or Control; an app or kind of window on the exclusion list; and anything while the screen is locked, ' +
    'capture is paused, or you are away. A password field is checked for as you type and before each piece is saved, and a piece is refused when that check fails or cannot tell. ' +
    'Characters typed between two checks can still be kept, so turn this off before you type a password. ' +
    'Card-like numbers and key-like tokens are replaced before saving. A password typed into an ordinary text box is not recognised.',
  /** The switch's note when this build has no keyboard hook, so the switch cannot take effect. */
  unsupported:
    'Not available in this build. It needs a keyboard hook, which this version does not include, so no text is kept.',
  /** The switch's note when keyboard access has not been granted. */
  needsPermission: 'Keyboard access has not been granted to companyOS, so no typed text is kept.',
  /** The name of the delete control that removes typed text with the screen and audio text. */
  deleteLabel: 'Delete screen, audio and typed text',
} as const;

/** The switch's note for the channel state: the full note while it can run, and the reason when it cannot. */
export function keystrokeNote(state: CaptureChannelState): string {
  if (state === 'unsupported') return KEYSTROKE_COPY.unsupported;
  if (state === 'needs_permission') return KEYSTROKE_COPY.needsPermission;
  return KEYSTROKE_COPY.note;
}
