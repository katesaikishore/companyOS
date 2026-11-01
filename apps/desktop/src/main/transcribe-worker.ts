/**
 * Turns one segment of microphone audio into text. This file is the entry point of an Electron utility process, so the
 * speech model never runs on the main thread. The model is read only from its bundle folder, and only after every file
 * there has matched its pin. Remote models are switched off before anything loads, so the worker makes no network call.
 * Replies carry the text or a stage name only. Error text can hold speech, so it is never sent, and log output is dropped.
 */
import { env, pipeline, type AllTasks } from '@huggingface/transformers';
import { WHISPER_BUNDLE, verifyBundle, whisperDirectory } from '@companyos/twin-core';
import { isAbsolute } from 'node:path';

// No remote model, ever. A file that is missing is an error, and nothing is cached next to the library.
env.allowRemoteModels = false;
env.useFSCache = false;

type Recognizer = AllTasks['automatic-speech-recognition'];

/** The messages the main process sends. Exported as types only, so the main process never loads the runtime. */
export type TranscribeRequest = { type: 'load'; id: number; modelsDir: string } | { type: 'transcribe'; id: number; samples: ArrayBuffer };

export type TranscribeReply =
  | { type: 'loaded'; id: number }
  | { type: 'transcribed'; id: number; text: string }
  | { type: 'failed'; id: number; stage: 'load' | 'transcribe' };

const MAX_PATH_CHARS = 1_024;
/** Sixty seconds of 16 kHz mono audio, as 32-bit floats. The capture window cuts segments at thirty seconds. */
const MAX_SAMPLES = 16_000 * 60;
const MAX_REPLY_CHARS = 10_000;

/** Requests run one after another, so the model is never asked two things at once. */
let chain: Promise<void> = Promise.resolve();
let loading: Promise<Recognizer> | undefined;
let modelsRoot: string | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks the shape of a request. The main process is trusted, but a malformed message must never reach the model. */
function parseRequest(value: unknown): TranscribeRequest | undefined {
  if (!isRecord(value) || !Number.isInteger(value.id)) return undefined;
  const id = value.id as number;
  if (value.type === 'load') {
    const { modelsDir } = value;
    if (typeof modelsDir !== 'string' || modelsDir.length > MAX_PATH_CHARS || !isAbsolute(modelsDir)) return undefined;
    return { type: 'load', id, modelsDir };
  }
  if (value.type === 'transcribe') {
    const { samples } = value;
    if (!(samples instanceof ArrayBuffer)) return undefined;
    if (samples.byteLength === 0 || samples.byteLength % 4 !== 0 || samples.byteLength > MAX_SAMPLES * 4) return undefined;
    return { type: 'transcribe', id, samples };
  }
  return undefined;
}

/** Loads the recognizer once. Every file is checked first, so a changed or partial file is never read. */
function recognizerFor(root: string): Promise<Recognizer> {
  loading ??= loadRecognizer(root).catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

async function loadRecognizer(root: string): Promise<Recognizer> {
  const directory = whisperDirectory(root);
  // The error text is never sent, so it only has to be clear to a reader of this file.
  if (!(await verifyBundle(WHISPER_BUNDLE, directory))) throw new Error('The speech model files do not match their pins.');
  return pipeline('automatic-speech-recognition', directory, { dtype: 'q8', device: 'cpu', local_files_only: true });
}

function reply(message: TranscribeReply): void {
  process.parentPort.postMessage(message);
}

async function handle(request: TranscribeRequest): Promise<void> {
  if (request.type === 'load') {
    modelsRoot = request.modelsDir;
    try {
      await recognizerFor(request.modelsDir);
      reply({ type: 'loaded', id: request.id });
    } catch {
      reply({ type: 'failed', id: request.id, stage: 'load' });
    }
    return;
  }
  if (modelsRoot === undefined) {
    reply({ type: 'failed', id: request.id, stage: 'load' });
    return;
  }
  let recognizer: Recognizer;
  try {
    recognizer = await recognizerFor(modelsRoot);
  } catch {
    reply({ type: 'failed', id: request.id, stage: 'load' });
    return;
  }
  try {
    const output = await recognizer(new Float32Array(request.samples));
    const text = typeof output.text === 'string' ? output.text.slice(0, MAX_REPLY_CHARS) : '';
    reply({ type: 'transcribed', id: request.id, text });
  } catch {
    reply({ type: 'failed', id: request.id, stage: 'transcribe' });
  }
}

/** A malformed message that still has an id is answered as a failure, so the caller never waits on it. */
function refuse(value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value.id)) return;
  reply({ type: 'failed', id: value.id as number, stage: value.type === 'load' ? 'load' : 'transcribe' });
}

process.parentPort.on('message', event => {
  const request = parseRequest(event.data);
  // One failed request must not stop the queue behind it.
  if (request) chain = chain.then(() => handle(request)).catch(() => undefined);
  else refuse(event.data);
});
