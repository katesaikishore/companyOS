import { describe, expect, it, vi } from 'vitest';
import {
  createKeyboardSource,
  keyEventFromHook,
  type HookApi,
  type HookKeyEvent,
  type HookKeyPress,
  type HookModule,
} from '../src/main/keyboard';

/*
 * The key mapping and the hook source. No test loads the real module: the hook is a fake that records its calls and emits
 * key-down events on demand. Key codes are libuiohook's VC_ codes (libuiohook/include/uiohook.h), as the native hook reports them.
 */

const press = (keycode: number, over: Partial<HookKeyPress> = {}): HookKeyPress => ({
  keycode,
  shift: false,
  control: false,
  alt: false,
  meta: false,
  ...over,
});

/** The letter key codes, in the order a to z. */
const LETTER_CODES = [
  0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32, 0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16,
  0x2f, 0x11, 0x2d, 0x15, 0x2c,
];
const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

describe('keyEventFromHook, US layout', () => {
  it('maps every letter to its lower-case character', () => {
    LETTER_CODES.forEach((code, index) => {
      expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'text', text: LETTERS[index] });
    });
  });

  it('maps a letter to upper case with Shift, and with Caps Lock alone', () => {
    expect(keyEventFromHook(press(0x1e, { shift: true }), false)).toEqual({ kind: 'text', text: 'A' });
    expect(keyEventFromHook(press(0x1e), true)).toEqual({ kind: 'text', text: 'A' });
  });

  it('maps a letter to lower case when Shift and Caps Lock are both on, since they cancel', () => {
    expect(keyEventFromHook(press(0x1e, { shift: true }), true)).toEqual({ kind: 'text', text: 'a' });
  });

  it('maps the digit keys to digits, and to the US symbols with Shift, which Caps Lock does not change', () => {
    const digits = [0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b];
    const plain = '1234567890';
    const shifted = '!@#$%^&*()';
    digits.forEach((code, index) => {
      expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'text', text: plain[index] });
      expect(keyEventFromHook(press(code, { shift: true }), false)).toEqual({ kind: 'text', text: shifted[index] });
      expect(keyEventFromHook(press(code), true)).toEqual({ kind: 'text', text: plain[index] });
    });
  });

  it('maps the punctuation keys to their US characters, with and without Shift', () => {
    const table: Array<[number, string, string]> = [
      [0x29, '`', '~'],
      [0x0c, '-', '_'],
      [0x0d, '=', '+'],
      [0x1a, '[', '{'],
      [0x1b, ']', '}'],
      [0x2b, '\\', '|'],
      [0x27, ';', ':'],
      [0x28, "'", '"'],
      [0x33, ',', '<'],
      [0x34, '.', '>'],
      [0x35, '/', '?'],
    ];
    for (const [code, plain, shifted] of table) {
      expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'text', text: plain });
      expect(keyEventFromHook(press(code, { shift: true }), false)).toEqual({ kind: 'text', text: shifted });
    }
  });

  it('maps Space to a space', () => {
    expect(keyEventFromHook(press(0x39), false)).toEqual({ kind: 'text', text: ' ' });
  });

  it('maps Enter and keypad Enter to enter, with or without Shift', () => {
    expect(keyEventFromHook(press(0x1c), false)).toEqual({ kind: 'enter' });
    expect(keyEventFromHook(press(0xe1c), false)).toEqual({ kind: 'enter' });
    expect(keyEventFromHook(press(0x1c, { shift: true }), false)).toEqual({ kind: 'enter' });
  });

  it('maps Tab to tab and Backspace to backspace, with or without Shift', () => {
    expect(keyEventFromHook(press(0x0f), false)).toEqual({ kind: 'tab' });
    expect(keyEventFromHook(press(0x0f, { shift: true }), false)).toEqual({ kind: 'tab' });
    expect(keyEventFromHook(press(0x0e), false)).toEqual({ kind: 'backspace' });
    expect(keyEventFromHook(press(0x0e, { shift: true }), false)).toEqual({ kind: 'backspace' });
  });

  it('maps the caret keys, Home, End and the page keys to other, so they end a piece and add no text', () => {
    const caret = [0xe048, 0xe04b, 0xe04d, 0xe050, 0x0e47, 0x0e4f, 0x0e49, 0x0e51];
    for (const code of caret) expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'other' });
  });

  it('maps Escape, Insert, forward Delete, the function keys and the keypad digits to other', () => {
    for (const code of [0x01, 0x0e52, 0x0e53, 0x3b, 0x44, 0x58, 0x4f, 0x52]) {
      expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'other' });
    }
  });

  it('maps a key it does not know to other, so it ends the piece', () => {
    expect(keyEventFromHook(press(0x0056), false)).toEqual({ kind: 'other' });
  });

  it('reports Shift, Control, Alt, Meta, Caps Lock, Num Lock and Scroll Lock pressed on their own as modifiers', () => {
    for (const code of [0x2a, 0x36, 0x1d, 0xe1d, 0x38, 0xe38, 0xe5b, 0xe5c, 0x3a, 0x45, 0x46]) {
      expect(keyEventFromHook(press(code), false)).toEqual({ kind: 'modifier' });
      expect(keyEventFromHook(press(code, { shift: true, control: true, alt: true, meta: true }), true)).toEqual({ kind: 'modifier' });
    }
  });

  it('reports a letter with Control, Command or Option held as a shortcut, never as text', () => {
    expect(keyEventFromHook(press(0x2e, { control: true }), false)).toEqual({ kind: 'shortcut' });
    expect(keyEventFromHook(press(0x2f, { meta: true }), false)).toEqual({ kind: 'shortcut' });
    expect(keyEventFromHook(press(0x12, { alt: true }), false)).toEqual({ kind: 'shortcut' });
    expect(keyEventFromHook(press(0x1e, { control: true, shift: true }), true)).toEqual({ kind: 'shortcut', rewritesText: true });
  });

  it('reports Backspace, Enter and Tab with a modifier held as a shortcut', () => {
    expect(keyEventFromHook(press(0x1c, { meta: true }), false)).toEqual({ kind: 'shortcut' });
    expect(keyEventFromHook(press(0x0f, { alt: true }), false)).toEqual({ kind: 'shortcut' });
    // Backspace with a modifier deletes a word or a line, so it rewrites the open piece.
    expect(keyEventFromHook(press(0x0e, { control: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true });
  });

  it('marks select all, cut, undo and word or line deletion as rewriting the open piece', () => {
    expect(keyEventFromHook(press(0x1e, { meta: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Cmd+A
    expect(keyEventFromHook(press(0x2d, { control: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Ctrl+X
    expect(keyEventFromHook(press(0x2c, { meta: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Cmd+Z
    expect(keyEventFromHook(press(0x0e, { alt: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Option+Delete
    expect(keyEventFromHook(press(0x0e, { meta: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Cmd+Delete
    expect(keyEventFromHook(press(0x0e53, { control: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Ctrl+Forward Delete
    expect(keyEventFromHook(press(0x0e53, { alt: true }), false)).toEqual({ kind: 'shortcut', rewritesText: true }); // Option+Forward Delete
  });

  it('does not mark copy, paste or a plain Delete as rewriting the open piece', () => {
    expect(keyEventFromHook(press(0x2e, { control: true }), false)).toEqual({ kind: 'shortcut' }); // Ctrl+C
    expect(keyEventFromHook(press(0x2f, { meta: true }), false)).toEqual({ kind: 'shortcut' }); // Cmd+V
    expect(keyEventFromHook(press(0x0e53, { meta: true }), false)).toEqual({ kind: 'shortcut' }); // Cmd+Forward Delete
  });

  it('reports a punctuation key with Control held as a shortcut', () => {
    expect(keyEventFromHook(press(0x0d, { control: true }), false)).toEqual({ kind: 'shortcut' });
  });
});

/** A fake hook. It records its calls and delivers key-down events when the test emits them. */
function fakeHook(options: { startThrows?: boolean; onThrows?: boolean } = {}) {
  const listeners = new Set<(event: HookKeyEvent) => void>();
  const calls = { on: 0, off: 0, start: 0, stop: 0 };
  const hook: HookApi & { emit(keycode: number, over?: Partial<HookKeyEvent>): void; listenerCount(): number; calls: typeof calls } = {
    calls,
    on(_event, listener) {
      calls.on += 1;
      if (options.onThrows) throw new Error('listener refused');
      listeners.add(listener);
      return hook;
    },
    off(_event, listener) {
      calls.off += 1;
      listeners.delete(listener);
      return hook;
    },
    start() {
      calls.start += 1;
      if (options.startThrows) throw new Error('UIOHOOK_ERROR_AXAPI_DISABLED');
    },
    stop() {
      calls.stop += 1;
    },
    emit(keycode, over = {}) {
      for (const listener of [...listeners]) {
        listener({ keycode, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...over });
      }
    },
    listenerCount() {
      return listeners.size;
    },
  };
  return hook;
}

const loaderFor = (hook: HookApi): (() => HookModule) => () => ({ uIOhook: hook });

describe('the keyboard source when the hook is missing', () => {
  it('is not available when the module fails to load, and never starts a hook', () => {
    const source = createKeyboardSource('darwin', () => {
      throw new Error("Cannot find module 'uiohook-napi'");
    });
    expect(source.available).toBe(false);
    expect(source.unavailableReason).toContain('did not load');
    expect(source.unavailableReason).not.toContain('Cannot find module');
    const onKey = vi.fn();
    expect(source.start(onKey)).toBe(false);
    expect(source.permissionGranted()).toBe(false);
    source.stop();
    expect(onKey).not.toHaveBeenCalled();
  });

  it('is not available when the module loads without its hook object', () => {
    const source = createKeyboardSource('darwin', () => ({}) as unknown as HookModule);
    expect(source.available).toBe(false);
    expect(source.start(() => undefined)).toBe(false);
  });

  it('is not available on Windows or Linux, says macOS only, and does not load the module there', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const loader = vi.fn(loaderFor(fakeHook()));
      const source = createKeyboardSource(platform, loader);
      expect(source.available).toBe(false);
      expect(source.unavailableReason).toContain('macOS only');
      expect(source.start(() => undefined)).toBe(false);
      expect(loader).not.toHaveBeenCalled();
    }
  });
});

describe('the keyboard source with a hook', () => {
  it('is available on macOS and reports each key-down press as a key event', () => {
    const hook = fakeHook();
    const source = createKeyboardSource('darwin', loaderFor(hook));
    const seen: unknown[] = [];
    expect(source.available).toBe(true);
    expect(source.start(event => seen.push(event))).toBe(true);
    expect(source.permissionGranted()).toBe(true);

    hook.emit(0x23, { shiftKey: true });
    hook.emit(0x2e, { ctrlKey: true });
    hook.emit(0x1c);
    expect(seen).toEqual([{ kind: 'text', text: 'H' }, { kind: 'shortcut' }, { kind: 'enter' }]);
  });

  it('starts the hook once, and stops it and removes its listener when stopped', () => {
    const hook = fakeHook();
    const source = createKeyboardSource('darwin', loaderFor(hook));
    source.start(() => undefined);
    expect(source.start(() => undefined)).toBe(true);
    expect(hook.calls.start).toBe(1);
    expect(hook.calls.on).toBe(1);
    expect(hook.listenerCount()).toBe(1);

    source.stop();
    expect(hook.calls.stop).toBe(1);
    expect(hook.listenerCount()).toBe(0);
    expect(source.permissionGranted()).toBe(false);

    source.stop();
    expect(hook.calls.stop).toBe(1);
  });

  it('can start again after it stopped, and reports only once per press', () => {
    const hook = fakeHook();
    const source = createKeyboardSource('darwin', loaderFor(hook));
    const onKey = vi.fn();
    source.start(onKey);
    source.stop();
    hook.emit(0x1e);
    expect(onKey).not.toHaveBeenCalled();
    source.start(onKey);
    hook.emit(0x1e);
    expect(onKey).toHaveBeenCalledTimes(1);
    expect(onKey).toHaveBeenCalledWith({ kind: 'text', text: 'a' });
  });

  it('reports no permission and keeps no listener when the hook does not start', () => {
    const hook = fakeHook({ startThrows: true });
    const source = createKeyboardSource('darwin', loaderFor(hook));
    const onKey = vi.fn();
    expect(source.start(onKey)).toBe(false);
    expect(source.permissionGranted()).toBe(false);
    expect(hook.listenerCount()).toBe(0);
    hook.emit(0x1e);
    expect(onKey).not.toHaveBeenCalled();
  });

  it('tracks Caps Lock from its own presses, so a letter after it is upper case', () => {
    const hook = fakeHook();
    const source = createKeyboardSource('darwin', loaderFor(hook));
    const seen: unknown[] = [];
    source.start(event => seen.push(event));
    hook.emit(0x3a);
    hook.emit(0x1e);
    hook.emit(0x3a);
    hook.emit(0x1e);
    expect(seen).toEqual([{ kind: 'modifier' }, { kind: 'text', text: 'A' }, { kind: 'modifier' }, { kind: 'text', text: 'a' }]);
  });

  it('keeps going after the listener throws, and the error does not leave the hook', () => {
    const hook = fakeHook();
    const source = createKeyboardSource('darwin', loaderFor(hook));
    const onKey = vi
      .fn<(event: unknown) => void>()
      .mockImplementationOnce(() => {
        throw new Error('the text must not be kept in an error');
      })
      .mockImplementation(() => undefined);
    source.start(onKey);
    expect(() => hook.emit(0x1e)).not.toThrow();
    hook.emit(0x30);
    expect(onKey).toHaveBeenCalledTimes(2);
    expect(onKey).toHaveBeenLastCalledWith({ kind: 'text', text: 'b' });
  });

  it('does not start if the hook refuses its listener', () => {
    const hook = fakeHook({ onThrows: true });
    const source = createKeyboardSource('darwin', loaderFor(hook));
    expect(source.start(() => undefined)).toBe(false);
    expect(hook.calls.start).toBe(0);
    expect(source.permissionGranted()).toBe(false);
  });
});
