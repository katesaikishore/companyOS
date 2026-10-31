import { describe, expect, it } from 'vitest';
import { parseKeyChord, xdotoolChord } from '../src';

/** Every key the chord grammar accepts. The Linux table must cover all of them, so it cannot fall behind the grammar. */
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

describe('xdotoolChord', () => {
  it('covers every key the grammar accepts', () => {
    for (const key of GRAMMAR_KEYS) {
      expect(xdotoolChord(`ctrl+${key}`), key).toBeDefined();
    }
  });

  it('never produces super, whatever modifiers the chord has', () => {
    expect(xdotoolChord('cmd+ctrl+alt+shift+a')).toBe('ctrl+alt+shift+a');
    for (const modifier of ['cmd', 'ctrl', 'alt', 'shift']) {
      const built = xdotoolChord(`${modifier}+a`);
      expect(built, modifier).toBeDefined();
      expect(built, modifier).not.toMatch(/super/i);
    }
  });

  it('maps the primary modifier cmd to Control, as Windows does, and writes Control once', () => {
    expect(xdotoolChord('cmd+c')).toBe('ctrl+c');
    expect(xdotoolChord('cmd+ctrl+c')).toBe('ctrl+c');
    expect(xdotoolChord('cmd+shift+k')).toBe('ctrl+shift+k');
  });

  it('maps alt and shift by name', () => {
    expect(xdotoolChord('alt+tab')).toBe('alt+Tab');
    expect(xdotoolChord('alt+shift+f4')).toBe('alt+shift+F4');
  });

  it('maps the named keys to xdotool keysym names, with delete as BackSpace', () => {
    expect(xdotoolChord('ctrl+return')).toBe('ctrl+Return');
    expect(xdotoolChord('ctrl+delete')).toBe('ctrl+BackSpace');
    expect(xdotoolChord('ctrl+pageup')).toBe('ctrl+Page_Up');
    expect(xdotoolChord('ctrl+space')).toBe('ctrl+space');
  });

  it('refuses a chord the grammar does not allow, so nothing is built from it', () => {
    for (const chord of ['notakey', 'ctrl+', '+a', 'ctrl+$(id)', 'ctrl+a;rm']) {
      expect(parseKeyChord(chord) === chord, chord).toBe(false);
      expect(xdotoolChord(chord), chord).toBeUndefined();
    }
  });
});
