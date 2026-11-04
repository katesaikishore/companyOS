/**
 * Turns text into BGE vectors. This file is the entry point of an Electron utility process, so the model never runs on the
 * main thread. The model is read only from its bundle folder, and only after every file there has matched its pin. Remote
 * models are switched off before anything loads, so the process makes no network call. Replies carry vectors or a stage
 * name only: the texts are file contents and questions, so error text is never sent and log output is dropped.
 */
import { env, pipeline, type AllTasks } from '@huggingface/transformers';
import { BGE_BUNDLE, bgeDirectory, verifyBundle } from '@companyos/twin-core';
import { BGE_VECTOR_VALUES, parseBgeRequest, type BgeReply, type BgeRequest } from './bge-protocol';

// No remote model, ever. A file that is missing is an error, and nothing is cached next to the library.
env.allowRemoteModels = false;
env.useFSCache = false;

type Extractor = AllTasks['feature-extraction'];

/** Requests run one after another, so the model is never asked two things at once. */
let chain: Promise<void> = Promise.resolve();
let loading: Promise<Extractor> | undefined;
let modelsRoot: string | undefined;

/** Loads the model once. Every file is checked first, so a changed or partial file is never read. */
function extractorFor(root: string): Promise<Extractor> {
  loading ??= loadExtractor(root).catch(error => {
    loading = undefined;
    throw error;
  });
  return loading;
}

async function loadExtractor(root: string): Promise<Extractor> {
  const directory = bgeDirectory(root);
  if (!(await verifyBundle(BGE_BUNDLE, directory))) throw new Error('The embedding model files do not match their pins.');
  return pipeline('feature-extraction', directory, { dtype: 'q8', device: 'cpu', local_files_only: true });
}

function reply(message: BgeReply): void {
  process.parentPort.postMessage(message);
}

async function handle(request: BgeRequest): Promise<void> {
  if (request.type === 'load') {
    modelsRoot = request.modelsDir;
    try {
      await extractorFor(modelsRoot);
      reply({ type: 'loaded', id: request.id });
    } catch {
      reply({ type: 'failed', id: request.id, stage: 'load' });
    }
    return;
  }
  try {
    if (!modelsRoot) throw new Error('No model is loaded.');
    const extractor = await extractorFor(modelsRoot);
    // BGE takes the first token's vector as the text's meaning, normalised, so a dot product is the cosine.
    const output = await extractor(request.texts, { pooling: 'cls', normalize: true });
    const values = Float32Array.from(output.data as ArrayLike<number>);
    if (values.length !== request.texts.length * BGE_VECTOR_VALUES) throw new Error('The model gave vectors of another size.');
    reply({ type: 'embedded', id: request.id, vectors: values.buffer });
  } catch {
    reply({ type: 'failed', id: request.id, stage: 'embed' });
  }
}

process.parentPort.on('message', event => {
  const request = parseBgeRequest(event.data);
  // One failed request must not stop the queue behind it.
  if (request) chain = chain.then(() => handle(request)).catch(() => undefined);
});
