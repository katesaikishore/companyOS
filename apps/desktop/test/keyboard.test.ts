import { describe, expect, it, vi } from 'vitest';
import {
  createKeyboardSource,
  keyEventFromMac,
  keyEventFromWindows,
  type MacKeyPress,
  type NativeKeyTap,
  type WindowsKeyPress,
} from '../src/main/keyboard';

const mac = (over: Partial<MacKeyPress>): MacKeyPress => ({
  keyCode: 0,
  down: true,
  command: false,
  control: false,
  characters: '',
  ...over,
});

const win = (over: Partial<WindowsKeyPress>): WindowsKeyPress => ({
  vkCode: 0,
  down: true,
  control: false,
  alt: false,
  win: false,
  characters: '',
  ...over,
});

describe('macOS key presses', () => {
  it('reports a printable character as text', () => {
    expect(keyEventFromMac(mac({ keyCode: 4, characters: 'h' }))).toEqual({ kind: 'text', text: 'h' });
  });

  it('reports Delete as backspace, and Return and keypad Enter as enter', () => {
    expect(keyEventFromMac(mac({ keyCode: 51 }))).toEqual({ kind: 'backspace' });
    expect(keyEventFromMac(mac({ keyCode: 36 }))).toEqual({ kind: 'enter' });
    expect(keyEventFromMac(mac({ keyCode: 76 }))).toEqual({ kind: 'enter' });
  });

  it('reports Tab as tab', () => {
    expect(keyEventFromMac(mac({ keyCode: 48 }))).toEqual({ kind: 'tab' });
  });

  it('reports arrows, Home, End, paging, Escape, forward Delete and function keys as other', () => {
    for (const keyCode of [53, 117, 115, 119, 116, 121, 123, 124, 125, 126, 122, 111]) {
      expect(keyEventFromMac(mac({ keyCode }))).toEqual({ kind: 'other' });
    }
  });

  it('reports a modifier pressed on its own as a modifier, for every modifier key code', () => {
    for (const keyCode of [54, 55, 56, 57, 58, 59, 60, 61, 62, 63]) {
      expect(keyEventFromMac(mac({ keyCode, characters: '' }))).toEqual({ kind: 'modifier' });
    }
  });

  it('reports any key with Command or Control held as a shortcut, and never as text', () => {
    expect(keyEventFromMac(mac({ keyCode: 9, command: true, characters: 'v' }))).toEqual({ kind: 'shortcut' });
    expect(keyEventFromMac(mac({ keyCode: 0, control: true, characters: 'a' }))).toEqual({ kind: 'shortcut' });
    expect(keyEventFromMac(mac({ keyCode: 51, command: true }))).toEqual({ kind: 'shortcut' });
  });

  it('reports nothing for a key release', () => {
    expect(keyEventFromMac(mac({ keyCode: 4, characters: 'h', down: false }))).toBeNull();
  });

  it('reports an unknown key that makes no character as other, so it ends a piece', () => {
    expect(keyEventFromMac(mac({ keyCode: 200, characters: '' }))).toEqual({ kind: 'other' });
  });

  it('keeps no control character from the characters of a key', () => {
    expect(keyEventFromMac(mac({ keyCode: 36, characters: '\r' }))).toEqual({ kind: 'enter' });
    expect(keyEventFromMac(mac({ keyCode: 4, characters: '\u0007' }))).toEqual({ kind: 'other' });
  });
});

describe('Windows key presses', () => {
  it('reports a printable character as text', () => {
    expect(keyEventFromWindows(win({ vkCode: 0x48, characters: 'H' }))).toEqual({ kind: 'text', text: 'H' });
  });

  it('reports Backspace, Enter, Tab and the navigation keys', () => {
    expect(keyEventFromWindows(win({ vkCode: 0x08 }))).toEqual({ kind: 'backspace' });
    expect(keyEventFromWindows(win({ vkCode: 0x0d }))).toEqual({ kind: 'enter' });
    expect(keyEventFromWindows(win({ vkCode: 0x09 }))).toEqual({ kind: 'tab' });
    for (const vkCode of [0x1b, 0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2e, 0x70, 0x7b]) {
      expect(keyEventFromWindows(win({ vkCode }))).toEqual({ kind: 'other' });
    }
  });

  it('reports Shift, Control, Alt, Caps Lock and the Windows keys as modifiers', () => {
    for (const vkCode of [0x10, 0x11, 0x12, 0x14, 0x5b, 0x5c, 0xa0, 0xa1, 0xa2, 0xa3, 0xa4, 0xa5]) {
      expect(keyEventFromWindows(win({ vkCode }))).toEqual({ kind: 'modifier' });
    }
  });

  it('reports Control or a Windows key held with a letter as a shortcut', () => {
    expect(keyEventFromWindows(win({ vkCode: 0x56, control: true, characters: 'v' }))).toEqual({ kind: 'shortcut' });
    expect(keyEventFromWindows(win({ vkCode: 0x45, win: true, characters: 'e' }))).toEqual({ kind: 'shortcut' });
  });

  it('reads Control with Alt, which types AltGr characters on many layouts, as text when a character comes with it', () => {
    expect(keyEventFromWindows(win({ vkCode: 0x51, control: true, alt: true, characters: '@' }))).toEqual({
      kind: 'text',
      text: '@',
    });
    expect(keyEventFromWindows(win({ vkCode: 0x51, control: true, alt: true, characters: '' }))).toEqual({ kind: 'shortcut' });
  });

  it('reports nothing for a key release', () => {
    expect(keyEventFromWindows(win({ vkCode: 0x48, characters: 'H', down: false }))).toBeNull();
  });
});

describe('the keyboard source for this system', () => {
  it('is not available on Linux, and says so', () => {
    const source = createKeyboardSource('linux');
    expect(source.available).toBe(false);
    expect(source.unavailableReason).toBe('Typed text is not available on this system.');
    expect(source.start(() => undefined)).toBe(false);
    expect(source.permissionGranted()).toBe(false);
  });

  it('is not available on macOS without a tap, and says the hook is missing', () => {
    const source = createKeyboardSource('darwin');
    expect(source.available).toBe(false);
    expect(source.unavailableReason).toContain('keyboard hook');
    expect(source.start(() => undefined)).toBe(false);
  });

  it('is not available on Windows without a tap, and says password fields cannot be detected', () => {
    const source = createKeyboardSource('win32');
    expect(source.available).toBe(false);
    expect(source.unavailableReason).toContain('Password fields also cannot be detected');
    expect(source.permissionGranted()).toBe(false);
  });

  it('passes each mapped press from a supplied macOS tap, and drops the ones that map to nothing', () => {
    const presses: Array<(press: MacKeyPress) => void> = [];
    const stop = vi.fn();
    const tap: NativeKeyTap<MacKeyPress> = {
      start: onPress => {
        presses.push(onPress);
        return true;
      },
      stop,
    };
    const source = createKeyboardSource('darwin', { darwin: tap });
    const seen: unknown[] = [];
    expect(source.available).toBe(true);
    expect(source.start(event => seen.push(event))).toBe(true);
    expect(source.permissionGranted()).toBe(true);

    presses[0](mac({ keyCode: 4, characters: 'h' }));
    presses[0](mac({ keyCode: 4, characters: 'h', down: false }));
    presses[0](mac({ keyCode: 36 }));
    expect(seen).toEqual([{ kind: 'text', text: 'h' }, { kind: 'enter' }]);

    source.stop();
    expect(stop).toHaveBeenCalledTimes(1);
    expect(source.permissionGranted()).toBe(false);
  });

  it('reports no permission when the tap refuses to start, so nothing is reported', () => {
    const tap: NativeKeyTap<WindowsKeyPress> = { start: () => false, stop: () => undefined };
    const source = createKeyboardSource('win32', { win32: tap });
    expect(source.start(() => undefined)).toBe(false);
    expect(source.permissionGranted()).toBe(false);
  });
});
