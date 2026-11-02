/**
 * Computes a voice embedding for one stretch of audio. This file is the entry point of an Electron utility process, so the
 * speaker model never runs on the main thread. The model is a local ONNX file, read only from its bundle folder and only after
 * every file there has matched its pin. onnxruntime is given a path and never a URL, so the process makes no network call.
 * Replies carry the embedding or a stage name only. Errors are never sent, and output is dropped, since the audio is personal.
 */
import { FBANK_MEL_BINS, SPEAKER_BUNDLE, fbankFeatures, speakerDirectory, speakerModelPath, verifyBundle } from '@companyos/twin-core';
import { InferenceSession, Tensor } from 'onnxruntime-node';
import { parseSpeakerRequest, SPEAKER_EMBEDDING_VALUES, type SpeakerReply, type SpeakerRequest } from './speaker-protocol';

let chain: Promise<void> = Promise.resolve();
let loading: Promise<InferenceSession> | undefined;
let modelsRoot: string | undefined;

/** Loads the model once. Every file is checked first, so a changed or partial file is never read. */
function sessionFor(root: string): Promise<InferenceSession> {
  loading ??= loadSession(root).catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

async function loadSession(root: string): Promise<InferenceSession> {
  if (!(await verifyBundle(SPEAKER_BUNDLE, speakerDirectory(root)))) throw new Error('The speaker model files do not match their pins.');
  return InferenceSession.create(speakerModelPath(root), { executionProviders: ['cpu'], logSeverityLevel: 4 });
}

function reply(message: SpeakerReply): void {
  process.parentPort.postMessage(message);
}

/** The embedding of one segment as raw bytes, or undefined when the segment is too short for one frame. */
async function embed(root: string, samples: ArrayBuffer): Promise<ArrayBuffer | undefined> {
  const session = await sessionFor(root);
  const features = fbankFeatures(new Float32Array(samples));
  if (features.frames === 0) return undefined;
  const input = session.inputNames[0];
  const output = session.outputNames[0];
  const tensor = new Tensor('float32', features.data, [1, features.frames, FBANK_MEL_BINS]);
  const result = await session.run({ [input]: tensor });
  const out = result[output];
  if (!out || out.type !== 'float32' || out.data.length !== SPEAKER_EMBEDDING_VALUES) throw new Error('The speaker model returned an unexpected shape.');
  return Float32Array.from(out.data as Float32Array).buffer;
}

async function handle(request: SpeakerRequest): Promise<void> {
  if (request.type === 'load') {
    modelsRoot = request.modelsDir;
    try {
      await sessionFor(request.modelsDir);
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
  try {
    const vector = await embed(modelsRoot, request.samples);
    if (vector === undefined) reply({ type: 'failed', id: request.id, stage: 'embed' });
    else reply({ type: 'embedded', id: request.id, vector });
  } catch {
    reply({ type: 'failed', id: request.id, stage: 'embed' });
  }
}

/** A malformed message that still has an id is answered as a failure, so the caller never waits on it. */
function refuse(value: unknown): void {
  if (typeof value !== 'object' || value === null) return;
  const { id, type } = value as { id?: unknown; type?: unknown };
  if (typeof id !== 'number' || !Number.isInteger(id)) return;
  reply({ type: 'failed', id, stage: type === 'load' ? 'load' : 'embed' });
}

process.parentPort.on('message', event => {
  const request = parseSpeakerRequest(event.data);
  // One failed request must not stop the queue behind it.
  if (request) chain = chain.then(() => handle(request)).catch(() => undefined);
  else refuse(event.data);
});
