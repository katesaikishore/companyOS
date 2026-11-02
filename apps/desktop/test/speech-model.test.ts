import { describe, expect, it } from 'vitest';
import { WHISPER_MODEL_ID } from '@companyos/twin-core';
import { SPEECH_MODEL_ID } from '../src/renderer/speech-model';

describe('speech model id in the renderer', () => {
  it('is the same id the core package installs the speech model under', () => {
    expect(SPEECH_MODEL_ID).toBe(WHISPER_MODEL_ID);
  });
});
