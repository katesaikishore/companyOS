import type { KeyEvent } from '@companyos/twin-core';

/**
 * The keyboard source behind typed-text capture. It reports each key press as a KeyEvent, and the keystroke service decides
 * what becomes text. Only a key press is reported: a key release does nothing here.
 *
 * The source is a keyboard hook from uiohook-napi (MIT, with prebuilt Node-API binaries, so nothing is compiled). The module
 * is loaded inside a try block when the source is made. If it is missing or cannot load, the source reports itself as not
 * available, and the app runs with typed text off.
 *
 * Only macOS takes the hook. The policy keeps a piece only when secure input is known to be off, and only macOS reports
 * that. Elsewhere the policy refuses every piece, so a hook there would read every key and keep none. Those systems report
 * the source as not available, and no hook is started on them.
 *
 * The hook reports key codes, not characters. The mapping is for the US layout only: a key code names a place on the
 * keyboard, so on another layout the characters would be wrong. Caps Lock is not reported as a state, so it is tracked from
 * the presses seen while the source runs, and it is assumed off until the first one.
 *
 * Starting uiohook on Linux without an X display aborts the whole process, and a throw in the try block cannot catch that.
 * The module loads on Linux, but the source never loads it there, so it is never started there.
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

/** One key-down press, as the mapping reads it. The code is the key's place on the keyboard (a libuiohook VC_ code). */
export interface HookKeyPress {
  keycode: number;
  shift: boolean;
  control: boolean;
  alt: boolean;
  meta: boolean;
}

/** A key-down event as uiohook-napi passes it to JavaScript. Key-up events are never subscribed to. */
export interface HookKeyEvent {
  keycode: number;
  shiftKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
}

/** The part of uiohook-napi's hook object that this module uses. */
export interface HookApi {
  on(event: 'keydown', listener: (event: HookKeyEvent) => void): unknown;
  off(event: 'keydown', listener: (event: HookKeyEvent) => void): unknown;
  start(): void;
  stop(): void;
}

/** The module's exports that this module uses. */
export interface HookModule {
  uIOhook: HookApi;
}

/**
 * libuiohook virtual key codes (VC_*), as in libuiohook/include/uiohook.h, which the native hook reports. Only the codes this
 * module reads are named here.
 */
const VC_BACKSPACE = 0x000e;
const VC_TAB = 0x000f;
const VC_ENTER = 0x001c;
const VC_KP_ENTER = 0x0e1c;
const VC_CAPS_LOCK = 0x003a;
const VC_A = 0x001e;
const VC_X = 0x002d;
const VC_Z = 0x002c;
const VC_DELETE = 0x0e53;

/** Modifier keys, pressed on their own they change nothing in the text: Shift, Control, Alt, Meta, Caps Lock, Num Lock, Scroll Lock. */
const MODIFIER_KEYS: ReadonlySet<number> = new Set([
  0x002a, 0x0036, // Shift left, right
  0x001d, 0x0e1d, // Control left, right
  0x0038, 0x0e38, // Alt left, right (Option on macOS)
  0x0e5b, 0x0e5c, // Meta left, right (Command on macOS, Windows on Windows)
  VC_CAPS_LOCK,
  0x0045, 0x0046, // Num Lock, Scroll Lock
]);

/** Letter keys, by code, as lower-case letters. Shift or Caps Lock makes them upper case. */
const LETTERS: ReadonlyMap<number, string> = new Map([
  [0x001e, 'a'], [0x0030, 'b'], [0x002e, 'c'], [0x0020, 'd'], [0x0012, 'e'], [0x0021, 'f'], [0x0022, 'g'], [0x0023, 'h'],
  [0x0017, 'i'], [0x0024, 'j'], [0x0025, 'k'], [0x0026, 'l'], [0x0032, 'm'], [0x0031, 'n'], [0x0018, 'o'], [0x0019, 'p'],
  [0x0010, 'q'], [0x0013, 'r'], [0x001f, 's'], [0x0014, 't'], [0x0016, 'u'], [0x002f, 'v'], [0x0011, 'w'], [0x002d, 'x'],
  [0x0015, 'y'], [0x002c, 'z'],
]);

/** Digit, space and punctuation keys, by code: the character without Shift, and the character with it (US layout). */
const SYMBOLS: ReadonlyMap<number, readonly [string, string]> = new Map([
  [0x0029, ['`', '~']],
  [0x0002, ['1', '!']], [0x0003, ['2', '@']], [0x0004, ['3', '#']], [0x0005, ['4', '$']], [0x0006, ['5', '%']],
  [0x0007, ['6', '^']], [0x0008, ['7', '&']], [0x0009, ['8', '*']], [0x000a, ['9', '(']], [0x000b, ['0', ')']],
  [0x000c, ['-', '_']], [0x000d, ['=', '+']],
  [0x001a, ['[', '{']], [0x001b, [']', '}']], [0x002b, ['\\', '|']],
  [0x0027, [';', ':']], [0x0028, ["'", '"']],
  [0x0033, [',', '<']], [0x0034, ['.', '>']], [0x0035, ['/', '?']],
  [0x0039, [' ', ' ']],
]);

/**
 * A shortcut that can delete or replace the text typed before it: select all, cut, undo, and deleting a word or a line.
 * The open piece is then dropped rather than stored, since the text it holds may be the text that was just removed.
 */
function rewritesText(press: HookKeyPress): boolean {
  const editing = press.control || press.meta;
  if (editing && (press.keycode === VC_A || press.keycode === VC_X || press.keycode === VC_Z)) return true;
  if (press.keycode === VC_BACKSPACE) return press.alt || press.control || press.meta;
  if (press.keycode === VC_DELETE) return press.alt || press.control;
  return false;
}

/**
 * The key event for one key-down press, on the US layout. A key with Control, Command or Option held is a shortcut, whatever
 * it would type, since its effect on the text is unknown. Every other key that is not listed (Escape, forward Delete, the
 * caret keys, Insert, Home and End, Page Up and Page Down, the function keys, the keypad digits) is 'other': it ends a piece
 * and adds no text. The keypad digits are not text, since Num Lock changes what they do.
 */
export function keyEventFromHook(press: HookKeyPress, capsLock: boolean): KeyEvent {
  if (MODIFIER_KEYS.has(press.keycode)) return { kind: 'modifier' };
  if (press.control || press.alt || press.meta) return rewritesText(press) ? { kind: 'shortcut', rewritesText: true } : { kind: 'shortcut' };
  if (press.keycode === VC_BACKSPACE) return { kind: 'backspace' };
  if (press.keycode === VC_TAB) return { kind: 'tab' };
  if (press.keycode === VC_ENTER || press.keycode === VC_KP_ENTER) return { kind: 'enter' };
  const letter = LETTERS.get(press.keycode);
  if (letter !== undefined) return { kind: 'text', text: press.shift !== capsLock ? letter.toUpperCase() : letter };
  const symbol = SYMBOLS.get(press.keycode);
  if (symbol !== undefined) return { kind: 'text', text: press.shift ? symbol[1] : symbol[0] };
  return { kind: 'other' };
}

/** Loads uiohook-napi. Called only on macOS, and only by createKeyboardSource, which catches the error when it fails. */
function loadHookModule(): HookModule {
  return require('uiohook-napi') as HookModule;
}

/** A source that never reports a key. Settings reads its reason. */
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

/**
 * The source backed by the hook. It listens for key-down presses only, maps each one with keyEventFromHook, and keeps the
 * Caps Lock state from its presses. The raw event is read and not kept, and nothing is logged.
 */
class HookKeyboardSource implements KeyboardSource {
  readonly available = true;
  readonly unavailableReason = '';
  private listener: ((event: HookKeyEvent) => void) | undefined;
  private capsLock = false;

  constructor(private readonly hook: HookApi) {}

  start(onKey: KeyListener): boolean {
    if (this.listener) return true;
    const listener = (event: HookKeyEvent): void => {
      const press: HookKeyPress = {
        keycode: event.keycode,
        shift: event.shiftKey,
        control: event.ctrlKey,
        alt: event.altKey,
        meta: event.metaKey,
      };
      if (press.keycode === VC_CAPS_LOCK) this.capsLock = !this.capsLock;
      try {
        onKey(keyEventFromHook(press, this.capsLock));
      } catch {
        // The press is dropped. An error from the service is not kept, since it could name part of the text.
      }
    };
    try {
      this.hook.on('keydown', listener);
      this.hook.start();
    } catch {
      // The hook did not start, for example without the permission. No detail is kept, and nothing is reported.
      this.removeListener(listener);
      return false;
    }
    this.listener = listener;
    return true;
  }

  stop(): void {
    const listener = this.listener;
    if (!listener) return;
    this.listener = undefined;
    try {
      this.hook.stop();
    } catch {
      // The hook is not running, so there is nothing more to stop.
    }
    this.removeListener(listener);
  }

  permissionGranted(): boolean {
    return this.listener !== undefined;
  }

  private removeListener(listener: (event: HookKeyEvent) => void): void {
    try {
      this.hook.off('keydown', listener);
    } catch {
      // The listener is already gone.
    }
  }
}

const NOT_ON_THIS_SYSTEM =
  'Typed text is kept on macOS only in this version. Only macOS can check for password fields, and typed text is refused wherever that check cannot be made.';
const HOOK_NOT_LOADED = 'Typed text on macOS needs the keyboard hook, and it did not load in this build, so no text is kept.';

/**
 * The source for this system. On macOS the hook is loaded here, inside a try block, and a failed load gives a source that is not
 * available. Every other system gets a source that is not available, and the loader is not called there.
 */
export function createKeyboardSource(
  platform: NodeJS.Platform = process.platform,
  loadHook: () => HookModule = loadHookModule,
): KeyboardSource {
  if (platform !== 'darwin') return new UnavailableSource(NOT_ON_THIS_SYSTEM);
  try {
    const hook = loadHook().uIOhook;
    if (hook && typeof hook.on === 'function' && typeof hook.off === 'function' && typeof hook.start === 'function' && typeof hook.stop === 'function') {
      return new HookKeyboardSource(hook);
    }
  } catch {
    // The module is missing or cannot load here. The source is not available, and no detail is kept.
  }
  return new UnavailableSource(HOOK_NOT_LOADED);
}
