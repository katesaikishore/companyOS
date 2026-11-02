import { describe, expect, it } from 'vitest';
import { MAX_CAPTURE_TEXT_CHARS, newId, normaliseOcr, normaliseTranscript, searchTerms } from '../src/capture-text';

/** A zero-width space, written as a code so the test source stays plain. */
const ZERO_WIDTH = String.fromCharCode(0x200b);

describe('normaliseOcr', () => {
  it('collapses whitespace, including line breaks, to single spaces', () => {
    expect(normaliseOcr('  Quarterly\t\tinvoice\n\n  reviewed   \r\n with finance  ')).toBe(
      'Quarterly invoice reviewed with finance',
    );
  });

  it('drops lines that hold only punctuation or symbols', () => {
    expect(normaliseOcr('Invoice 4417\n----------\n| | |\n...\nApproved')).toBe('Invoice 4417 Approved');
  });

  it('keeps a line that has a digit but no letter', () => {
    expect(normaliseOcr('2026\n%')).toBe('2026');
  });

  it('turns control and zero-width characters into spaces, so the words stay apart', () => {
    const bell = String.fromCharCode(7);
    expect(normaliseOcr(`alpha${ZERO_WIDTH}beta${bell}gamma`)).toBe('alpha beta gamma');
  });

  it('cuts the text to the maximum length, without splitting a character', () => {
    const cut = normaliseOcr('a'.repeat(MAX_CAPTURE_TEXT_CHARS + 500));
    expect(cut).toHaveLength(MAX_CAPTURE_TEXT_CHARS);
    // The last character is a pair of UTF-16 units. Cutting by unit would leave half of it behind.
    const emoji = normaliseOcr('x'.repeat(MAX_CAPTURE_TEXT_CHARS - 1) + '\u{1F600}\u{1F600}');
    expect(Array.from(emoji)).toHaveLength(MAX_CAPTURE_TEXT_CHARS);
    expect(emoji.endsWith('\u{1F600}')).toBe(true);
  });

  it('returns an empty string for a read with no text', () => {
    expect(normaliseOcr('   \n  \n')).toBe('');
  });
});

describe('normaliseTranscript', () => {
  it('drops bracketed tokens such as [BLANK_AUDIO]', () => {
    expect(normaliseTranscript('[BLANK_AUDIO] Let us move the review to Friday [Music]')).toBe(
      'Let us move the review to Friday',
    );
  });

  it('drops a word that repeats more than six times in a row', () => {
    const loop = Array.from({ length: 7 }, () => 'you').join(' ');
    expect(normaliseTranscript(`Send it ${loop} today`)).toBe('Send it today');
  });

  it('keeps a word that repeats six times in a row', () => {
    const run = Array.from({ length: 6 }, () => 'no').join(' ');
    expect(normaliseTranscript(`${run} thanks`)).toBe(`${run} thanks`);
  });

  it('counts a repeat across punctuation and capitals as the same word', () => {
    const run = ['you,', 'You.', 'YOU', 'you', 'you!', 'you?', 'you'].join(' ');
    expect(normaliseTranscript(`${run} done`)).toBe('done');
  });

  it('returns an empty string for empty or bracket-only input', () => {
    expect(normaliseTranscript('')).toBe('');
    expect(normaliseTranscript('   ')).toBe('');
    expect(normaliseTranscript('[BLANK_AUDIO]')).toBe('');
  });

  it('collapses whitespace and cuts to the maximum length', () => {
    expect(normaliseTranscript('one\n\ntwo   three')).toBe('one two three');
    const long = normaliseTranscript(Array.from({ length: 2000 }, (_, index) => `w${index}`).join(' '));
    expect(long.length).toBeLessThanOrEqual(MAX_CAPTURE_TEXT_CHARS);
    expect(long.startsWith('w0 w1 w2')).toBe(true);
  });
});

describe('searchTerms', () => {
  it('splits the search text into words', () => {
    expect(searchTerms('  invoice   approved ')).toEqual(['invoice', 'approved']);
  });

  it('drops words with no letter or digit', () => {
    expect(searchTerms('AND OR * - invoice ( ) 2026')).toEqual(['AND', 'OR', 'invoice', '2026']);
  });

  it('keeps at most eight words and sixty-four characters a word', () => {
    expect(searchTerms('a b c d e f g h i j')).toHaveLength(8);
    expect(searchTerms('x'.repeat(100))[0]).toHaveLength(64);
  });

  it('returns no words for empty input', () => {
    expect(searchTerms('')).toEqual([]);
    expect(searchTerms('   ')).toEqual([]);
  });
});

describe('newId', () => {
  it('gives thirty-two lower-case hex characters, and a new value each time', () => {
    const first = newId();
    expect(first).toMatch(/^[0-9a-f]{32}$/);
    expect(newId()).not.toBe(first);
  });
});
