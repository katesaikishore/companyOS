import { describe, expect, it } from 'vitest';
import { KeystrokeBuffer, normaliseTyped, type KeyEvent } from '../src/keystroke-text';

const T = (text: string): KeyEvent => ({ kind: 'text', text });

/** Types each character at its own time, one second apart from the start. */
function typeAt(buffer: KeystrokeBuffer, events: Array<[KeyEvent, number]>): ReturnType<KeystrokeBuffer['push']>[] {
  return events.map(([event, at]) => buffer.push(event, at));
}

describe('KeystrokeBuffer: assembling text', () => {
  it('joins printable characters in the order typed, and ends the piece at Enter', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [
      [T('h'), 1_000],
      [T('i'), 1_100],
      [T(' '), 1_200],
      [T('there'), 1_300],
    ]);
    expect(buffer.push({ kind: 'enter' }, 1_500)).toEqual({ text: 'hi there', startedAt: 1_000, endedAt: 1_500 });
    expect(buffer.length).toBe(0);
  });

  it('edits the buffer on Backspace, so a typo is not kept', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [
      [T('hellp'), 1_000],
      [{ kind: 'backspace' }, 1_100],
      [T('o'), 1_200],
    ]);
    expect(buffer.take()?.text).toBe('hello');
  });

  it('ignores Backspace on an empty piece without finishing anything', () => {
    const buffer = new KeystrokeBuffer();
    expect(buffer.push({ kind: 'backspace' }, 1_000)).toBeNull();
    expect(buffer.length).toBe(0);
  });

  it('removes a whole character on Backspace, even one outside the basic plane', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [
      [T('ok'), 1_000],
      [T('\u{1F642}'), 1_100],
      [{ kind: 'backspace' }, 1_200],
    ]);
    expect(buffer.take()?.text).toBe('ok');
  });

  it('ends the piece at Tab, and at any other key that can move the caret', () => {
    for (const event of [{ kind: 'tab' } as const, { kind: 'other' } as const]) {
      const buffer = new KeystrokeBuffer();
      typeAt(buffer, [[T('name'), 1_000]]);
      expect(buffer.push(event, 1_200)?.text).toBe('name');
    }
  });

  it('ends the piece at a shortcut, and never keeps the shortcut as text', () => {
    const buffer = new KeystrokeBuffer();
    expect(buffer.push({ kind: 'shortcut' }, 1_000)).toBeNull();
    expect(buffer.length).toBe(0);
    typeAt(buffer, [[T('draft'), 2_000]]);
    expect(buffer.push({ kind: 'shortcut' }, 2_500)?.text).toBe('draft');
    expect(buffer.length).toBe(0);
  });

  it('ignores a modifier key pressed on its own, and it does not restart the pause', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('abc'), 1_000]]);
    expect(buffer.push({ kind: 'modifier' }, 4_000)).toBeNull();
    expect(buffer.length).toBe(3);
    expect(buffer.poll(6_000)?.text).toBe('abc');
  });

  it('never keeps a control character from a text event', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('a\r\nb\tc​'), 1_000]]);
    expect(buffer.take()?.text).toBe('abc');
  });

  it('keeps nothing from a piece that is only spaces', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('   '), 1_000]]);
    expect(buffer.push({ kind: 'enter' }, 1_100)).toBeNull();
    expect(buffer.length).toBe(0);
  });

  it('starts a new piece with the time of its first character, after the last one ended', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('one'), 1_000]]);
    buffer.push({ kind: 'enter' }, 1_100);
    typeAt(buffer, [[T('two'), 9_000]]);
    expect(buffer.push({ kind: 'enter' }, 9_100)).toEqual({ text: 'two', startedAt: 9_000, endedAt: 9_100 });
  });
});

describe('KeystrokeBuffer: the pause and the length limit', () => {
  it('ends the piece after five seconds with no key, and not before', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('pause'), 1_000]]);
    expect(buffer.poll(5_999)).toBeNull();
    expect(buffer.poll(6_000)?.text).toBe('pause');
    expect(buffer.length).toBe(0);
  });

  it('restarts the five seconds with each key, so a steady typist is one piece', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [
      [T('a'), 1_000],
      [T('b'), 5_000],
      [T('c'), 9_000],
    ]);
    expect(buffer.poll(12_000)).toBeNull();
    expect(buffer.poll(14_000)?.text).toBe('abc');
  });

  it('finishes a piece at the length limit and keeps the rest of the text in the next one', () => {
    const buffer = new KeystrokeBuffer(5_000, 3);
    const finished = buffer.push(T('abcd'), 1_000);
    expect(finished).toEqual({ text: 'abc', startedAt: 1_000, endedAt: 1_000 });
    expect(buffer.take()?.text).toBe('d');
  });

  it('drops the open piece without keeping it when cleared', () => {
    const buffer = new KeystrokeBuffer();
    typeAt(buffer, [[T('secret'), 1_000]]);
    buffer.clear();
    expect(buffer.length).toBe(0);
    expect(buffer.poll(20_000)).toBeNull();
    expect(buffer.take()).toBeNull();
  });
});

describe('normaliseTyped', () => {
  it('trims both ends and removes control characters', () => {
    expect(normaliseTyped('  hello\u0007 world \n')).toBe('hello world');
  });

  it('caps the length at the capture limit, without splitting a character', () => {
    const long = `${'a'.repeat(3_999)}\u{1F642}z`;
    const cleaned = normaliseTyped(long);
    expect(Array.from(cleaned)).toHaveLength(4_000);
    expect(cleaned.endsWith('\u{1F642}')).toBe(true);
  });
});
