import { parseKeyChord } from './automation';

/**
 * How a checked key chord maps onto each operating system's key input. A chord is validated by parseKeyChord before
 * any of this runs, so the only keys are the fixed list there. Nothing here takes text from a step or from the screen,
 * and the output is built only from the fixed tables below, so it can be passed to an OS tool without a shell.
 */

export type ChordModifier = 'cmd' | 'ctrl' | 'alt' | 'shift';

export interface ChordParts {
  modifiers: ChordModifier[];
  key: string;
}

/** Splits a canonical chord, such as "cmd+shift+k", into its modifiers and key. Undefined for anything else. */
export function chordParts(chord: string): ChordParts | undefined {
  if (parseKeyChord(chord) !== chord) return undefined;
  const pieces = chord.split('+');
  const key = pieces.pop() ?? '';
  return { modifiers: pieces as ChordModifier[], key };
}

const LETTER_OR_DIGIT = /^[a-z0-9]$/;

/** Named keys on macOS, by Carbon virtual key code. "delete" is the key the Mac labels Delete, which deletes backwards. */
const MAC_KEY_CODES: Readonly<Record<string, number>> = {
  return: 36,
  tab: 48,
  space: 49,
  delete: 51,
  escape: 53,
  left: 123,
  right: 124,
  down: 125,
  up: 126,
  home: 115,
  end: 119,
  pageup: 116,
  pagedown: 121,
  f1: 122,
  f2: 120,
  f3: 99,
  f4: 118,
  f5: 96,
  f6: 97,
  f7: 98,
  f8: 100,
  f9: 101,
  f10: 109,
  f11: 103,
  f12: 111,
};

/** The modifier names System Events takes in its "using" list. "cmd" is Command on macOS. */
const MAC_MODIFIERS: Readonly<Record<ChordModifier, string>> = {
  cmd: 'command down',
  ctrl: 'control down',
  alt: 'option down',
  shift: 'shift down',
};

export interface MacKeyStroke {
  /** The virtual key code of a named key. Absent for a letter or digit. */
  keyCode?: number;
  /** The letter or digit to type. Present only when keyCode is absent. */
  character?: string;
  /** Modifier names, in the order of the chord. Never empty, because a chord has at least one modifier. */
  using: string[];
}

/** The System Events key press for a chord on macOS, or undefined when the chord is not one the grammar allows. */
export function macKeyStroke(chord: string): MacKeyStroke | undefined {
  const parts = chordParts(chord);
  if (!parts) return undefined;
  const using = parts.modifiers.map(modifier => MAC_MODIFIERS[modifier]);
  if (LETTER_OR_DIGIT.test(parts.key)) return { character: parts.key, using };
  const keyCode = MAC_KEY_CODES[parts.key];
  return keyCode === undefined ? undefined : { keyCode, using };
}

/**
 * Named keys in SendKeys syntax. Letters and digits are sent as themselves. "delete" is Backspace, as on macOS, so the
 * same chord means the same key on both systems.
 */
const WINDOWS_KEYS: Readonly<Record<string, string>> = {
  return: '{ENTER}',
  tab: '{TAB}',
  space: ' ',
  delete: '{BACKSPACE}',
  escape: '{ESC}',
  left: '{LEFT}',
  right: '{RIGHT}',
  down: '{DOWN}',
  up: '{UP}',
  home: '{HOME}',
  end: '{END}',
  pageup: '{PGUP}',
  pagedown: '{PGDN}',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `{F${index + 1}}`])),
};

/**
 * SendKeys prefixes. "cmd" is the primary modifier, so on Windows it is Control, as the chord grammar says. Control is
 * written once even when both "cmd" and "ctrl" are given.
 */
const WINDOWS_MODIFIERS: Readonly<Record<ChordModifier, string>> = {
  cmd: '^',
  ctrl: '^',
  alt: '%',
  shift: '+',
};

/** The SendKeys string for a chord on Windows, such as "^+k" for cmd+shift+k, or undefined when the chord is not allowed. */
export function windowsSendKeys(chord: string): string | undefined {
  const parts = chordParts(chord);
  if (!parts) return undefined;
  const key = LETTER_OR_DIGIT.test(parts.key) ? parts.key : WINDOWS_KEYS[parts.key];
  if (key === undefined) return undefined;
  const prefix = [...new Set(parts.modifiers.map(modifier => WINDOWS_MODIFIERS[modifier]))].join('');
  return `${prefix}${key}`;
}

/**
 * xdotool keysym names for the named keys. "delete" is BackSpace, as on the Mac, because the key the Mac labels Delete
 * deletes backwards.
 */
const XDO_KEYS: Readonly<Record<string, string>> = {
  return: 'Return',
  tab: 'Tab',
  space: 'space',
  delete: 'BackSpace',
  escape: 'Escape',
  left: 'Left',
  right: 'Right',
  down: 'Down',
  up: 'Up',
  home: 'Home',
  end: 'End',
  pageup: 'Page_Up',
  pagedown: 'Page_Down',
  ...Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`f${index + 1}`, `F${index + 1}`])),
};

/**
 * xdotool modifier names. "cmd" is the primary modifier, so on Linux it is Control, as it is on Windows. Control is
 * written once even when both "cmd" and "ctrl" are given.
 */
const XDO_MODIFIERS: Readonly<Record<ChordModifier, string>> = {
  cmd: 'ctrl',
  ctrl: 'ctrl',
  alt: 'alt',
  shift: 'shift',
};

/**
 * The xdotool key string for a chord, such as "ctrl+shift+k" for cmd+shift+k, or undefined when the chord is not allowed.
 * It is sent as one argument to xdotool, never through a shell.
 */
export function xdotoolChord(chord: string): string | undefined {
  const parts = chordParts(chord);
  if (!parts) return undefined;
  const key = LETTER_OR_DIGIT.test(parts.key) ? parts.key : XDO_KEYS[parts.key];
  if (key === undefined) return undefined;
  const modifiers = [...new Set(parts.modifiers.map(modifier => XDO_MODIFIERS[modifier]))];
  return [...modifiers, key].join('+');
}
