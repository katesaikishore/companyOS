/**
 * Reads the text of one screen frame. This file is the entry point of an Electron utility process, so OCR never runs on
 * the main thread. It makes no network calls: the recognition engine and its English data are read from the files
 * installed with the app, and nothing is downloaded or written to the working folder. It answers with the text or with a
 * stage name only. Error text is never sent to the main process, because it can name file paths or quote what was read.
 */
import { dirname, join, sep } from 'node:path';
import Tesseract from 'tesseract.js';

export type OcrRequest = { type: 'recognise'; id: number; png: Uint8Array };
export type OcrResponse =
  | { type: 'text'; id: number; text: string }
  | { type: 'failed'; id: number; stage: 'load' | 'recognise' };

/** The English model that tesseract.js itself uses for LSTM-only recognition. It is the smaller of the two in the package. */
const LANGUAGE_DIR = '4.0.0_best_int';

let engine: Promise<Tesseract.Worker> | undefined;

/**
 * The folder with the English data. A worker thread cannot read from inside the app archive, so in a packaged app the
 * data is read from the unpacked copy that the build keeps beside it.
 */
function languagePath(): string {
  const packageDir = dirname(require.resolve('@tesseract.js-data/eng'));
  return join(packageDir, LANGUAGE_DIR).replace(`${sep}app.asar${sep}`, `${sep}app.asar.unpacked${sep}`);
}

/** Starts the engine once. A failed start is forgotten, so the next frame tries again. */
function start(): Promise<Tesseract.Worker> {
  if (engine) return engine;
  const starting: Promise<Tesseract.Worker> = Tesseract.createWorker('eng', Tesseract.OEM.LSTM_ONLY, {
    langPath: languagePath(),
    cacheMethod: 'none',
    logger: () => undefined,
    // Without this, tesseract.js rethrows a failed read and the utility process exits. The failure still reaches the
    // caller as a rejected read, which is answered with a stage only.
    errorHandler: () => undefined,
  }).catch((error: unknown) => {
    engine = undefined;
    throw error;
  });
  engine = starting;
  return starting;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Checks the shape of a request. The main process is trusted, but a malformed message must never reach the engine. */
function parseRequest(value: unknown): OcrRequest | undefined {
  if (!isRecord(value)) return undefined;
  const { type, id, png } = value;
  if (type !== 'recognise' || !Number.isInteger(id) || !(png instanceof Uint8Array)) return undefined;
  return { type, id: id as number, png };
}

async function handle(request: OcrRequest): Promise<OcrResponse> {
  let worker: Tesseract.Worker;
  try {
    worker = await start();
  } catch {
    return { type: 'failed', id: request.id, stage: 'load' };
  }
  try {
    const { data } = await worker.recognize(Buffer.from(request.png));
    return { type: 'text', id: request.id, text: data.text };
  } catch {
    return { type: 'failed', id: request.id, stage: 'recognise' };
  }
}

function reply(message: OcrResponse): void {
  process.parentPort.postMessage(message);
}

// Frames are read one after another, so the engine never works on two frames at once.
let chain: Promise<void> = Promise.resolve();

process.parentPort.on('message', event => {
  const request = parseRequest(event.data);
  if (request) {
    chain = chain.then(() => handle(request)).then(reply).catch(() => undefined);
    return;
  }
  // A malformed message that still has an id is answered as a failure, so the caller never waits on it.
  if (isRecord(event.data) && Number.isInteger(event.data.id)) {
    reply({ type: 'failed', id: event.data.id as number, stage: 'recognise' });
  }
});
