/**
 * The page inside the hidden microphone window. While the main process says start, it reads the microphone, cuts the audio
 * into 30 second segments, drops silent segments, and sends the rest to the main process. Nothing is stored here. The page
 * has no network access, and it reaches the main process only through the capture bridge.
 */

declare global {
  interface Window {
    captureBridge: {
      sendSegment(samples: ArrayBuffer, durationMs: number): void;
      onCommand(listener: (command: string) => void): () => void;
    };
  }
}

/** The rate the speech model reads. The main process expects samples at this rate. */
const SAMPLE_RATE = 16_000;
const SEGMENT_SECONDS = 30;
/**
 * A segment whose average level stays below this is treated as silence and is not sent. This is a starting value, and it
 * has not been measured on a laptop microphone yet.
 */
const VOICE_LEVEL = 0.01;

interface Listening {
  stream: MediaStream;
  context: AudioContext;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  mute: GainNode;
  /** Blocks taken from the worklet since the last segment, at the device's rate. */
  blocks: Float32Array[];
  length: number;
}

let listening: Listening | undefined;
/** Every start and stop changes this, so a start that is still opening the microphone is cancelled by a later stop. */
let generation = 0;

/** Root-mean-square level of a segment: 0 for silence, and near 1 for full-scale sound. */
export function rmsLevel(samples: Float32Array): number {
  if (samples.length === 0) return 0;
  let sum = 0;
  for (const value of samples) sum += value * value;
  return Math.sqrt(sum / samples.length);
}

/**
 * Converts audio to 16 kHz. Downsampling averages each group of input samples, which keeps the speech and removes the
 * high frequencies that would otherwise fold back into it. Upsampling repeats the nearest sample.
 */
export function toSpeechRate(input: Float32Array, fromRate: number): Float32Array {
  if (fromRate === SAMPLE_RATE) return input;
  const ratio = fromRate / SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const output = new Float32Array(length);
  for (let index = 0; index < length; index++) {
    const start = Math.floor(index * ratio);
    const end = Math.min(input.length, Math.max(start + 1, Math.floor((index + 1) * ratio)));
    let sum = 0;
    for (let at = start; at < end; at++) sum += input[at];
    output[index] = sum / (end - start);
  }
  return output;
}

function collect(session: Listening, block: Float32Array): void {
  // A block that arrives after a stop belongs to a session that is gone, so it is dropped.
  if (listening !== session) return;
  session.blocks.push(block);
  session.length += block.length;
  if (session.length < SEGMENT_SECONDS * session.context.sampleRate) return;

  const merged = new Float32Array(session.length);
  let offset = 0;
  for (const part of session.blocks) {
    merged.set(part, offset);
    offset += part.length;
  }
  session.blocks = [];
  session.length = 0;

  const speech = toSpeechRate(merged, session.context.sampleRate);
  if (rmsLevel(speech) < VOICE_LEVEL) return;
  window.captureBridge.sendSegment(speech.slice().buffer, Math.round((speech.length / SAMPLE_RATE) * 1000));
}

async function start(): Promise<void> {
  if (listening) return;
  const current = ++generation;
  let stream: MediaStream | undefined;
  let context: AudioContext | undefined;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1 }, video: false });
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    await context.audioWorklet.addModule('./worklets/pcm-worklet.js');
    if (current !== generation) throw new Error('Cancelled.');

    const source = context.createMediaStreamSource(stream);
    const worklet = new AudioWorkletNode(context, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1] });
    // The worklet is pulled only when it reaches the output, so it runs through a muted gain. Nothing is played.
    const mute = context.createGain();
    mute.gain.value = 0;
    source.connect(worklet);
    worklet.connect(mute);
    mute.connect(context.destination);
    await context.resume();
    if (current !== generation) throw new Error('Cancelled.');

    const session: Listening = { stream, context, source, worklet, mute, blocks: [], length: 0 };
    worklet.port.onmessage = (event: MessageEvent<Float32Array>) => collect(session, event.data);
    listening = session;
  } catch {
    // The microphone could not be opened, or the request was cancelled. Nothing is kept, and no reason is shown.
    stream?.getTracks().forEach(track => track.stop());
    void context?.close().catch(() => undefined);
  }
}

function stop(): void {
  generation++;
  const session = listening;
  listening = undefined;
  if (!session) return;
  session.worklet.port.onmessage = null;
  session.source.disconnect();
  session.worklet.disconnect();
  session.mute.disconnect();
  session.stream.getTracks().forEach(track => track.stop());
  void session.context.close().catch(() => undefined);
}

window.captureBridge.onCommand(command => {
  if (command === 'start') void start();
  else stop();
});
