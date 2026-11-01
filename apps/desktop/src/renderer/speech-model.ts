/**
 * The id of the speech model, as the core package names it (WHISPER_MODEL_ID in packages/core/src/models/whisper.ts).
 * The renderer keeps its own copy, because it must not load the core package at run time. apps/desktop/test checks that
 * the two are equal.
 */
export const SPEECH_MODEL_ID = 'whisper-tiny-en';
