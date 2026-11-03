/**
 * The speaker model's id, and the shape of a session label, as the core package names them (SPEAKER_MODEL_ID in
 * packages/core/src/models/speaker.ts, and isSessionSpeakerLabel in packages/core/src/speaker/match.ts). The renderer keeps its
 * own copy, because it must not load the core package at run time. apps/desktop/test checks that the two are equal.
 */
export const SPEAKER_MODEL_ID = 'speaker-wespeaker-resnet34';

/** 'Speaker' and a number from 1 to 999, as a session label is written. A name the person gave does not match. */
const SESSION_SPEAKER_LABEL = /^Speaker [1-9][0-9]{0,2}$/;

/** True for a label the app gave to a voice nobody has named yet, such as 'Speaker 2'. */
export function isUnnamedSpeaker(label: string): boolean {
  return SESSION_SPEAKER_LABEL.test(label);
}
