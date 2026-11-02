import { MAX_CAPTURE_TEXT_CHARS } from './capture-text';

/**
 * Turns key presses into finished pieces of typed text. Pure: the desktop app maps each key press from the operating system
 * to one of these events, and decides with keystrokeDecision whether a key may be kept at all. This module never sees the
 * key's code, its window or its app.
 *
 * What is kept: printable characters, in the order typed, with Backspace removing the last one. A piece ends at Enter, Tab,
 * any other key that can move the caret (arrows, Home, End, Escape, forward Delete, function keys), a shortcut with Command
 * or Control held, a focus change (the caller ends it), or five seconds with no key. A modifier pressed alone is not text
 * and does nothing here. A shortcut is never kept as text, since its effect on the text is unknown. A shortcut that can delete
 * or replace the open text (select all, cut, undo, a word or line delete) drops the piece instead of ending it.
 */

/** One key press, as the desktop app reports it. Control characters never reach here as text. */
export type KeyEvent =
  | { kind: 'text'; text: string }
  | { kind: 'backspace' }
  | { kind: 'enter' }
  | { kind: 'tab' }
  /** Shift, Control, Alt, Command, Caps Lock and the like, pressed on their own. */
  | { kind: 'modifier' }
  /**
   * A key pressed with Command, Control or Option held. It is not kept as text. rewritesText is set by the caller for a
   * shortcut that can delete or replace the open text, such as select all, cut, undo or a word or line delete: the open
   * piece is then dropped, since the text it would keep may already be gone.
   */
  | { kind: 'shortcut'; rewritesText?: boolean }
  /** Any other key that may move the caret or change the text. It ends the piece. */
  | { kind: 'other' };

/** Five seconds with no key ends a piece. */
export const KEYSTROKE_PAUSE_MS = 5_000;
/** A piece is ended at this many characters, so a long run without a pause is still stored in parts. */
export const MAX_KEYSTROKE_ITEM_CHARS = 1_000;
/** The most characters one text event may carry. A longer one is cut here. */
const MAX_EVENT_CHARS = 64;

/** Control characters and zero-width marks. A key press never adds them to the text. */
const CONTROL_OR_HIDDEN = /[\p{Cc}​-‍﻿]/u;

/** A piece of finished text. startedAt is the time of its first character. */
export interface FinishedText {
  text: string;
  startedAt: number;
  endedAt: number;
}

/** Assembles one piece at a time. The caller passes the time of each event, so tests need no clock. */
export class KeystrokeBuffer {
  private chars: string[] = [];
  private startedAt = 0;
  private lastAt = 0;

  constructor(
    private readonly pauseMs = KEYSTROKE_PAUSE_MS,
    private readonly maxChars = MAX_KEYSTROKE_ITEM_CHARS,
  ) {}

  /** How many characters the open piece holds. */
  get length(): number {
    return this.chars.length;
  }

  /**
   * Applies one key press. Returns the piece it finished, or null when the press did not end one. A text event that fills
   * the piece to its limit finishes it, and the rest of that event starts the next piece.
   */
  push(event: KeyEvent, now: number): FinishedText | null {
    switch (event.kind) {
      case 'modifier':
        return null;
      case 'backspace':
        if (this.chars.length > 0) {
          this.chars.pop();
          this.lastAt = now;
        }
        return null;
      case 'text': {
        const printable = Array.from(event.text)
          .slice(0, MAX_EVENT_CHARS)
          .filter(char => !CONTROL_OR_HIDDEN.test(char));
        if (printable.length === 0) return null;
        if (this.chars.length === 0) this.startedAt = now;
        this.lastAt = now;
        let finished: FinishedText | null = null;
        for (const char of printable) {
          if (this.chars.length >= this.maxChars) finished = this.take(now);
          if (this.chars.length === 0) this.startedAt = now;
          this.chars.push(char);
        }
        return finished;
      }
      case 'shortcut':
        if (event.rewritesText) {
          this.clear();
          return null;
        }
        return this.take(now);
      default:
        return this.take(now);
    }
  }

  /** Ends the piece when five seconds or more have passed since its last key. Returns null otherwise. */
  poll(now: number): FinishedText | null {
    if (this.chars.length === 0 || now - this.lastAt < this.pauseMs) return null;
    return this.take(now);
  }

  /**
   * Ends the open piece now, for example on a focus change. Returns null when it holds nothing but spaces. The text is
   * trimmed at both ends, and no character is changed.
   */
  take(now = this.lastAt): FinishedText | null {
    if (this.chars.length === 0) return null;
    const text = this.chars.join('').trim();
    const startedAt = this.startedAt;
    const endedAt = now;
    this.chars = [];
    return text === '' ? null : { text, startedAt, endedAt };
  }

  /** Drops the open piece without keeping it. Used whenever the policy refuses, so nothing from a refused time is ended later. */
  clear(): void {
    this.chars = [];
  }
}

/** Cleans finished text before it is redacted and stored: control characters out, the ends trimmed, the length capped. */
export function normaliseTyped(raw: string): string {
  const text = Array.from(raw.replace(/[\p{Cc}​-‍﻿]/gu, '')).join('').trim();
  return Array.from(text).slice(0, MAX_CAPTURE_TEXT_CHARS).join('').trimEnd();
}
