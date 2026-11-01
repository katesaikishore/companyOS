import { randomBytes } from 'node:crypto';

/** The most characters kept from one screen read or one transcript. A longer one is cut here. */
export const MAX_CAPTURE_TEXT_CHARS = 4000;
/** A word repeated more than this many times in a row is a decoding loop, not speech, and is dropped. */
const MAX_WORD_RUN = 6;
const MAX_QUERY_TERMS = 8;
const MAX_TERM_CHARS = 64;

const LINE_BREAK = /\r\n|[\r\n\u2028\u2029]/;
/** Control characters and zero-width marks. They become spaces, so the words either side stay apart. */
const CONTROL_OR_HIDDEN = /[\p{Cc}\u200b-\u200d\ufeff]/gu;
const LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;
const NOT_LETTER_OR_DIGIT = /[^\p{L}\p{N}]/gu;
const BRACKETED = /\[[^\]]*\]/g;

/**
 * Cleans one screen read. Lines with no letter or digit are dropped, since they are only lines, rules or stray marks.
 * Whitespace is collapsed to single spaces, and the text is cut to MAX_CAPTURE_TEXT_CHARS.
 */
export function normaliseOcr(raw: string): string {
  const lines = raw.split(LINE_BREAK).map(line => clean(line)).filter(line => LETTER_OR_DIGIT.test(line));
  return limit(lines.join(' '));
}

/**
 * Cleans one transcript. Bracketed tokens such as [BLANK_AUDIO] are dropped, and so is any word repeated more than six
 * times in a row. Empty input gives an empty string, which the caller does not store.
 */
export function normaliseTranscript(raw: string): string {
  const words = clean(raw.replace(BRACKETED, ' '))
    .split(' ')
    .filter(word => word.length > 0);
  const kept: string[] = [];
  let start = 0;
  while (start < words.length) {
    const key = wordKey(words[start]);
    let end = start + 1;
    while (end < words.length && wordKey(words[end]) === key) end++;
    if (end - start <= MAX_WORD_RUN) kept.push(...words.slice(start, end));
    start = end;
  }
  return limit(kept.join(' '));
}

/**
 * Splits a search box entry into the words to match. Each word keeps its own characters, so a search for "a-b" still
 * matches. Words with no letter or digit are dropped, and only the first few are used, so a long paste stays cheap.
 */
export function searchTerms(text: string): string[] {
  return clean(text)
    .split(' ')
    .filter(term => LETTER_OR_DIGIT.test(term))
    .slice(0, MAX_QUERY_TERMS)
    .map(term => Array.from(term).slice(0, MAX_TERM_CHARS).join(''));
}

/** A random id of 16 bytes, written as 32 lower-case hex characters. */
export function newId(): string {
  return randomBytes(16).toString('hex');
}

/** Control characters become spaces, and runs of whitespace become one space. */
function clean(text: string): string {
  return text.replace(CONTROL_OR_HIDDEN, ' ').replace(/\s+/g, ' ').trim();
}

/** The word without its punctuation, so "you," and "you" count as the same word. A word with none keeps its form. */
function wordKey(word: string): string {
  const letters = word.toLowerCase().replace(NOT_LETTER_OR_DIGIT, '');
  return letters.length > 0 ? letters : word.toLowerCase();
}

/** Cuts text to the maximum length in characters, counting code points so a character is never split. */
function limit(text: string): string {
  if (text.length <= MAX_CAPTURE_TEXT_CHARS) return text;
  return Array.from(text).slice(0, MAX_CAPTURE_TEXT_CHARS).join('').trimEnd();
}
