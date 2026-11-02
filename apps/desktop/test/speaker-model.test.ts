import { describe, expect, it } from 'vitest';
// The engine's own source, not the built package, so the check compares against what the code says now.
import { SPEAKER_MODEL_ID } from '../../../packages/core/src/models/speaker';
import { isSessionSpeakerLabel } from '../../../packages/core/src/speaker/match';
import { SPEAKER_MODEL_ID as RENDERER_SPEAKER_MODEL_ID, isUnnamedSpeaker } from '../src/renderer/speaker-model';

describe('speaker model id and labels in the renderer', () => {
  it('is the same id the core package installs the speaker model under', () => {
    expect(RENDERER_SPEAKER_MODEL_ID).toBe(SPEAKER_MODEL_ID);
  });

  it('recognises an unnamed speaker exactly as the engine does', () => {
    const cases = ['Speaker 1', 'Speaker 2', 'Speaker 20', 'Speaker 999', 'Speaker 0', 'Speaker 01', 'speaker 2', 'Speaker 1000', 'Ada', 'Speaker 2 ', ''];
    for (const label of cases) {
      expect(isUnnamedSpeaker(label), label).toBe(isSessionSpeakerLabel(label));
    }
  });
});
