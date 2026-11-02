import type { KeyEvent } from '@companyos/twin-core';

/**
 * The keyboard source behind typed-text capture. It reports each key press as a KeyEvent, and the keystroke service decides
 * what becomes text. Only a key press is reported: a key release does nothing here.
 *
 * No native keyboard hook ships with this build. A hook on macOS is a listen-only event tap, which needs the Input
 * Monitoring permission. A hook on Windows is a low-level keyboard hook. Either needs a native module, and this build adds
 * no native dependency, since one would break the install on some system. So the sources below report themselves as not
 * available until a tap is supplied. The mapping from key codes to key events is written and tested here, so a tap only has
 * to report raw presses.
 */

export type KeyListener = (event: KeyEvent) => void;

export interface KeyboardSource {
  /** Starts reporting key presses. Returns false when no hook could be started, so nothing will be reported. */
  start(onKey: KeyListener): boolean;
  stop(): void;
  /** Whether key presses are being delivered now. This stands in for the permission: a hook that cannot start has none. */
  permissionGranted(): boolean;
  /** Whether a keyboard hook exists for this system at all. */
  readonly available: boolean;
  /** A fixed sentence for Settings, saying why typed text is not available. */
  readonly unavailableReason: string;
}

/** One key press as a macOS event tap reports it. Only key-down presses are passed on. */
export interface MacKeyPress {
  keyCode: number;
  down: boolean;
  command: boolean;
  control: boolean;
  /** The characters the key produces with the current layout and modifiers, or an empty string. */
  characters: string;
}

/** One key press as a Windows low-level keyboard hook reports it. Only key-down presses are passed on. */
export interface WindowsKeyPress {
  vkCode: number;
  down: boolean;
  control: boolean;
  alt: boolean;
  win: boolean;
  /** The characters the key produces, from ToUnicode, or an empty string. */
  characters: string;
}

/** A native event hook. The app supplies one when a native module is present. Each press is passed to onPress. */
export interface NativeKeyTap<Press> {
  start(onPress: (press: Press) => void): boolean;
  stop(): void;
}

const CONTROL_OR_HIDDEN = /[\p{Cc}​-‍﻿]/gu;

/** Printable text from a key press, or 'other' when the key produced no printable character. */
function printable(characters: string): KeyEvent {
  const text = characters.replace(CONTROL_OR_HIDDEN, '');
  return text.length > 0 ? { kind: 'text', text } : { kind: 'other' };
}

/** macOS virtual key codes (Carbon kVK_ values). */
const MAC_MODIFIER_KEYS = new Set([54, 55, 56, 57, 58, 59, 60, 61, 62, 63]); // Command, Shift, Caps Lock, Option, Control, fn
const MAC_RETURN_KEYS = new Set([36, 76]); // Return, keypad Enter
const MAC_BACKSPACE = 51; // Delete (the key labelled Delete, which deletes backwards)
const MAC_TAB = 48;
const MAC_OTHER_KEYS = new Set([
  53, // Escape
  117, // Forward delete
  115, // Home
  119, // End
  116, // Page up
  121, // Page down
  123, 124, 125, 126, // arrows
  122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, // F1 to F12
]);

/** The event for one macOS key press. A key with Command or Control held is a shortcut, whatever it types. */
export function keyEventFromMac(press: MacKeyPress): KeyEvent | null {
  if (!press.down) return null;
  if (MAC_MODIFIER_KEYS.has(press.keyCode)) return { kind: 'modifier' };
  if (press.command || press.control) return { kind: 'shortcut' };
  if (press.keyCode === MAC_BACKSPACE) return { kind: 'backspace' };
  if (MAC_RETURN_KEYS.has(press.keyCode)) return { kind: 'enter' };
  if (press.keyCode === MAC_TAB) return { kind: 'tab' };
  if (MAC_OTHER_KEYS.has(press.keyCode)) return { kind: 'other' };
  return printable(press.characters);
}

/** Windows virtual-key codes (VK_ values). */
const WIN_MODIFIER_KEYS = new Set([0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0x90, 0x91, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]);
const WIN_BACK = 0x08;
const WIN_TAB = 0x09;
const WIN_RETURN = 0x0d;
const WIN_OTHER_KEYS = new Set([
  0x1b, // Escape
  0x21, 0x22, 0x23, 0x24, // page up, page down, end, home
  0x25, 0x26, 0x27, 0x28, // arrows
  0x2d, 0x2e, // insert, delete
  0x70, 0x71, 0x72, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x7b, // F1 to F12
]);

/**
 * The event for one Windows key press. Control with Alt is AltGr on many layouts, and it types a character, so it is text
 * when a character comes with it. Any other Control or Windows key is a shortcut.
 */
export function keyEventFromWindows(press: WindowsKeyPress): KeyEvent | null {
  if (!press.down) return null;
  if (WIN_MODIFIER_KEYS.has(press.vkCode)) return { kind: 'modifier' };
  const altGr = press.control && press.alt && printable(press.characters).kind === 'text';
  if (!altGr && (press.control || press.win)) return { kind: 'shortcut' };
  if (press.vkCode === WIN_BACK) return { kind: 'backspace' };
  if (press.vkCode === WIN_RETURN) return { kind: 'enter' };
  if (press.vkCode === WIN_TAB) return { kind: 'tab' };
  if (WIN_OTHER_KEYS.has(press.vkCode)) return { kind: 'other' };
  return printable(press.characters);
}

/** A source whose tap is missing. It never reports a key, and Settings says why. */
class UnavailableSource implements KeyboardSource {
  readonly available = false;
  constructor(readonly unavailableReason: string) {}
  start(): boolean {
    return false;
  }
  stop(): void {}
  permissionGranted(): boolean {
    return false;
  }
}

/** A source backed by a native tap, which maps each press to a key event. Without a tap it is not available. */
export class NativeKeyboardSource<Press> implements KeyboardSource {
  private running = false;

  constructor(
    private readonly options: {
      tap: NativeKeyTap<Press> | undefined;
      toEvent: (press: Press) => KeyEvent | null;
      unavailableReason: string;
    },
  ) {}

  get available(): boolean {
    return this.options.tap !== undefined;
  }

  get unavailableReason(): string {
    return this.options.unavailableReason;
  }

  start(onKey: KeyListener): boolean {
    const tap = this.options.tap;
    if (!tap || this.running) return this.running;
    this.running = tap.start(press => {
      const event = this.options.toEvent(press);
      if (event) onKey(event);
    });
    return this.running;
  }

  stop(): void {
    if (!this.running) return;
    this.options.tap?.stop();
    this.running = false;
  }

  permissionGranted(): boolean {
    return this.running;
  }
}

/**
 * The source for this system. macOS and Windows each take a tap when the app supplies one. Linux has no hook in this version:
 * on X11 any program in the session can read the same keys, and Wayland does not allow a global hook.
 */
export function createKeyboardSource(
  platform: NodeJS.Platform = process.platform,
  taps: { darwin?: NativeKeyTap<MacKeyPress>; win32?: NativeKeyTap<WindowsKeyPress> } = {},
): KeyboardSource {
  if (platform === 'darwin') {
    return new NativeKeyboardSource<MacKeyPress>({
      tap: taps.darwin,
      toEvent: keyEventFromMac,
      unavailableReason: 'Typed text on macOS needs a keyboard hook and the Input Monitoring permission. This build does not include one.',
    });
  }
  if (platform === 'win32') {
    return new NativeKeyboardSource<WindowsKeyPress>({
      tap: taps.win32,
      toEvent: keyEventFromWindows,
      unavailableReason:
        'Typed text on Windows needs a keyboard hook. This build does not include one. Password fields also cannot be detected there yet, so typed text would be refused.',
    });
  }
  return new UnavailableSource('Typed text is not available on this system.');
}
