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
    expect(note).toContain('Command, Control or Option');
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

describe('the typed-text note states the limits of the keyboard hook', () => {
  it('says the text is kept on this device, encrypted', () => {
    expect(KEYSTROKE_COPY.note).toContain('encrypted on this device');
  });

  it('says only the US layout is read, and why another layout gives wrong text', () => {
    expect(KEYSTROKE_COPY.note).toContain('US keyboard layout');
    expect(KEYSTROKE_COPY.note).toContain('wrong');
  });

  it('says passwords are refused where secure input is detected, and not every field reports it', () => {
    expect(KEYSTROKE_COPY.note).toContain('refused where secure input is detected');
    expect(KEYSTROKE_COPY.note).toContain('not every password field reports it');
  });

  it('says what macOS asks for when the switch is turned on, which is Accessibility access', () => {
    expect(KEYSTROKE_COPY.note).toContain('On macOS');
    expect(KEYSTROKE_COPY.note).toContain('Accessibility access');
    expect(KEYSTROKE_COPY.note).not.toContain('does not include');
  });

  it('says the switch is not available here, and why, when the hook cannot run on this system', () => {
    expect(KEYSTROKE_COPY.unsupported.startsWith('Not available in this build.')).toBe(true);
    expect(KEYSTROKE_COPY.unsupported).toContain('macOS only');
  });

  it('tells the person what to do when the hook could not start', () => {
    expect(KEYSTROKE_COPY.needsPermission).toContain('Accessibility');
    expect(KEYSTROKE_COPY.needsPermission).toContain('turn this off and on again');
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
