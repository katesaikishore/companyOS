import { CAPTURE_KINDS, RETENTION_DAYS } from '@companyos/twin-core';
import { describe, expect, it } from 'vitest';
import { KEYSTROKE_COPY, keystrokeNote } from '../src/renderer/keystroke-copy';
import { KIND_LABEL, KIND_OPTIONS, TEXT_KEPT_DAYS } from '../src/renderer/recall-model';

/**
 * The typed-text copy states what is kept and when it is refused. The renderer cannot import the engine's values, so these
 * checks tie the wording to the engine: the retention period, the kinds of capture, and each refusal the policy makes.
 */
describe('the typed-text copy matches the engine', () => {
  it('says the text is kept for the same period as the rest of the history', () => {
    expect(TEXT_KEPT_DAYS).toBe(RETENTION_DAYS);
    expect(KEYSTROKE_COPY.note).toContain(`${RETENTION_DAYS} days`);
  });

  it('states each refusal the policy makes', () => {
    const note = KEYSTROKE_COPY.note;
    expect(note).toContain('browser');
    expect(note).toContain('password field');
    expect(note).toContain('exclusion list');
    expect(note).toContain('Command or Control');
    expect(note).toContain('locked');
    expect(note).toContain('paused');
    expect(note).toContain('away');
  });

  it('says what is kept and what is replaced, and that a password in a plain text box is not recognised', () => {
    const note = KEYSTROKE_COPY.note;
    expect(note).toContain('Card-like numbers and key-like tokens are replaced');
    expect(note).toContain('not recognised');
  });

  it('names typed text in the delete control', () => {
    expect(KEYSTROKE_COPY.deleteLabel).toContain('typed text');
  });

  it('gives the reason in the note when the switch cannot take effect or access is missing', () => {
    expect(keystrokeNote('unsupported')).toBe(KEYSTROKE_COPY.unsupported);
    expect(keystrokeNote('needs_permission')).toBe(KEYSTROKE_COPY.needsPermission);
    expect(keystrokeNote('on')).toBe(KEYSTROKE_COPY.note);
    expect(keystrokeNote('off')).toBe(KEYSTROKE_COPY.note);
  });
});

describe('the Recall page covers every kind of captured item', () => {
  it('offers each kind of item as a filter, after Everything', () => {
    expect(KIND_OPTIONS.map(option => option.value)).toEqual(['all', ...CAPTURE_KINDS]);
  });

  it('has a short label for every kind', () => {
    for (const kind of CAPTURE_KINDS) expect(KIND_LABEL[kind]).toBeTruthy();
  });
});
