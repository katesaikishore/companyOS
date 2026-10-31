import { describe, expect, it } from 'vitest';
import { chordParts, macKeyStroke, parseKeyChord, windowsSendKeys } from '../src';

/** Every key the chord grammar accepts. The OS tables must cover all of them, so they cannot fall behind the grammar. */
const GRAMMAR_KEYS = [
  ...'abcdefghijklmnopqrstuvwxyz0123456789'.split(''),
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  'return',
  'tab',
  'escape',
  'space',
  'delete',
  'up',
  'down',
  'left',
  'right',
  'home',
  'end',
  'pageup',
  'pagedown',
];

const MAC_MODIFIER_NAMES = ['command down', 'control down', 'option down', 'shift down'];

describe('chordParts', () => {
  it('splits a canonical chord into its modifiers and key', () => {
    expect(chordParts('cmd+shift+k')).toEqual({ modifiers: ['cmd', 'shift'], key: 'k' });
    expect(chordParts('alt+f4')).toEqual({ modifiers: ['alt'], key: 'f4' });
  });

  it('returns nothing for a chord that is not in canonical form', () => {
    expect(chordParts('shift+cmd+k')).toBeUndefined();
  });
});

describe('every key the grammar allows', () => {
  it.each(GRAMMAR_KEYS)('has a macOS and a Windows form for %s', key => {
    const chord = `cmd+${key}`;
    expect(parseKeyChord(chord)).toBe(chord);
    expect(macKeyStroke(chord)).toBeDefined();
    expect(windowsSendKeys(chord)).toBeDefined();
  });

  it('sends only the fixed set of characters on Windows, so no key text can be injected', () => {
    for (const key of GRAMMAR_KEYS) {
      expect(windowsSendKeys(`ctrl+alt+shift+${key}`)).toMatch(/^[%^+]+(\{[A-Z0-9]+\}|[a-z0-9 ])$/);
    }
  });

  it('uses only the four modifier names on macOS', () => {
    for (const key of GRAMMAR_KEYS) {
      const stroke = macKeyStroke(`cmd+ctrl+alt+shift+${key}`);
      expect(stroke?.using).toHaveLength(4);
      for (const name of stroke?.using ?? []) {
        expect(MAC_MODIFIER_NAMES).toContain(name);
      }
    }
  });
});

describe('macKeyStroke', () => {
  it('types a letter or digit by its character, with the modifiers in chord order', () => {
    expect(macKeyStroke('cmd+shift+k')).toEqual({ character: 'k', using: ['command down', 'shift down'] });
    expect(macKeyStroke('alt+7')).toEqual({ character: '7', using: ['option down'] });
  });

  it('presses a named key by its virtual key code', () => {
    expect(macKeyStroke('ctrl+alt+return')).toEqual({ keyCode: 36, using: ['control down', 'option down'] });
    expect(macKeyStroke('cmd+f12')).toEqual({ keyCode: 111, using: ['command down'] });
    expect(macKeyStroke('cmd+pagedown')).toEqual({ keyCode: 121, using: ['command down'] });
  });

  it('reads cmd as Command on macOS', () => {
    expect(macKeyStroke('cmd+k')?.using).toEqual(['command down']);
  });

  it('refuses a chord that is not allowed', () => {
    expect(macKeyStroke('k')).toBeUndefined();
    expect(macKeyStroke('cmd+printscreen')).toBeUndefined();
  });
});

describe('windowsSendKeys', () => {
  it('reads cmd as Control on Windows, which is the primary modifier', () => {
    expect(windowsSendKeys('cmd+shift+k')).toBe('^+k');
    expect(windowsSendKeys('ctrl+k')).toBe('^k');
  });

  it('writes Control once when both cmd and ctrl are given', () => {
    expect(windowsSendKeys('cmd+ctrl+k')).toBe('^k');
  });

  it('writes alt and shift as their SendKeys prefixes', () => {
    expect(windowsSendKeys('alt+f4')).toBe('%{F4}');
    expect(windowsSendKeys('alt+shift+f4')).toBe('%+{F4}');
  });

  it('writes named keys in SendKeys braces, and space as a literal space', () => {
    expect(windowsSendKeys('shift+return')).toBe('+{ENTER}');
    expect(windowsSendKeys('cmd+pagedown')).toBe('^{PGDN}');
    expect(windowsSendKeys('cmd+delete')).toBe('^{BACKSPACE}');
    expect(windowsSendKeys('cmd+space')).toBe('^ ');
  });

  it('sends a digit as itself', () => {
    expect(windowsSendKeys('cmd+1')).toBe('^1');
  });

  it('refuses a chord that is not allowed', () => {
    expect(windowsSendKeys('k')).toBeUndefined();
    expect(windowsSendKeys('cmd+{')).toBeUndefined();
  });
});

describe('a chord that the mapping refuses', () => {
  it.each([
    ['not in canonical order', 'shift+cmd+k'],
    ['no modifier', 'k'],
    ['an uppercase key', 'cmd+K'],
    ['an unknown key', 'cmd+printscreen'],
    ['two keys', 'cmd+k+k'],
    ['no key', 'cmd+'],
    ['empty', ''],
  ])('refuses %s on both systems', (_label, chord) => {
    expect(chordParts(chord)).toBeUndefined();
    expect(macKeyStroke(chord)).toBeUndefined();
    expect(windowsSendKeys(chord)).toBeUndefined();
  });
});
