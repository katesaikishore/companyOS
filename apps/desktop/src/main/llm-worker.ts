/**
 * Runs the local model. This file is the entry point of an Electron utility process, so inference never blocks the
 * window or capture. It talks to the main process only through the messages in @companyos/twin-core, and it makes no
 * network calls: llama.cpp runs from prebuilt binaries only (build 'never', no download), and it loads a model file
 * from the models folder the main process gave it. Log output is discarded, so nothing the model sees reaches a log.
 */
import { pathToFileURL } from 'node:url';
import type { Llama, LlamaContext, LlamaGrammar, LlamaModel } from 'node-llama-cpp';
import {
  isModelTemplate,
  MAX_WORKER_TEXT_CHARS,
  modelThreads,
  noThinkPrompt,
  resolveModelPath,
  type ModelTemplate,
  type WorkerRequest,
  type WorkerResponse,
} from '@companyos/twin-core';

type LlamaModule = typeof import('node-llama-cpp');
type LoadRequest = Extract<WorkerRequest, { type: 'load' }>;
type CompleteRequest = Extract<WorkerRequest, { type: 'complete' }>;

/**
 * node-llama-cpp is an ES module, and a plain import() would be compiled to require(). The import is built at run time
 * from the module's absolute file URL, so it does not depend on the working directory of the utility process.
 */
const importModule = new Function('url', 'return import(url)') as (url: string) => Promise<LlamaModule>;

const MAX_PATH_CHARS = 1_024;
const MAX_TOKENS_LIMIT = 256;

let modulePromise: Promise<LlamaModule> | undefined;
let llama: Llama | undefined;
let model: LlamaModel | undefined;
let context: LlamaContext | undefined;
let loadedPath: string | undefined;
let loadedTemplate: ModelTemplate | undefined;
const grammars = new Map<string, LlamaGrammar & { parse(text: string): unknown }>();
/** Requests run one after another, so one model is never asked two things at once. */
let chain: Promise<void> = Promise.resolve();

function moduleOnce(): Promise<LlamaModule> {
  modulePromise ??= importModule(pathToFileURL(require.resolve('node-llama-cpp')).href);
  return modulePromise;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isIntegerIn(value: unknown, min: number, max: number): value is number {
  return Number.isInteger(value) && (value as number) >= min && (value as number) <= max;
}

/** Checks the shape of a request. The main process is trusted, but a malformed message must never reach the model. */
function parseRequest(value: unknown): WorkerRequest | undefined {
  if (!isRecord(value) || !Number.isInteger(value.id)) return undefined;
  const id = value.id as number;
  if (value.type === 'load') {
    const { modelsDir, modelPath, contextSize, template } = value;
    if (typeof modelsDir !== 'string' || typeof modelPath !== 'string') return undefined;
    if (modelsDir.length > MAX_PATH_CHARS || modelPath.length > MAX_PATH_CHARS) return undefined;
    if (!isIntegerIn(contextSize, 512, 8192)) return undefined;
    if (!isModelTemplate(template)) return undefined;
    return { type: 'load', id, modelsDir, modelPath, contextSize, template };
  }
  if (value.type === 'complete') {
    const { system, prompt, schema, maxTokens } = value;
    if (typeof system !== 'string' || typeof prompt !== 'string' || !isRecord(schema)) return undefined;
    if (system.length > MAX_WORKER_TEXT_CHARS || prompt.length > MAX_WORKER_TEXT_CHARS) return undefined;
    if (!isIntegerIn(maxTokens, 1, MAX_TOKENS_LIMIT)) return undefined;
    return { type: 'complete', id, system, prompt, schema, maxTokens };
  }
  return undefined;
}

async function load(request: LoadRequest): Promise<void> {
  // The model must be a .gguf file inside the models folder, after symbolic links are followed. Anything else is
  // refused before the runtime sees it.
  const path = await resolveModelPath(request.modelsDir, request.modelPath);
  if (loadedPath === path && loadedTemplate === request.template && context) return;

  context = undefined;
  model = undefined;
  loadedPath = undefined;
  loadedTemplate = undefined;
  grammars.clear();
  const lib = await moduleOnce();
  // The Linux package holds only the CPU build (electron-builder.yml leaves out the GPU builds), so Linux asks for that
  // one. macOS and Windows keep the default, which picks Metal or CUDA when the machine has one.
  llama ??= await lib.getLlama({
    build: 'never',
    gpu: process.platform === 'linux' ? false : 'auto',
    skipDownload: true,
    progressLogs: false,
    logLevel: lib.LlamaLogLevel.disabled,
    logger: () => undefined,
  });
  model = await llama.loadModel({ modelPath: path });
  // Fewer threads than cores, so one busy program on the machine does not stall the model (see modelThreads).
  context = await model.createContext({ contextSize: request.contextSize, threads: modelThreads(llama.cpuMathCores) });
  loadedPath = path;
  loadedTemplate = request.template;
}

async function complete(request: CompleteRequest): Promise<unknown> {
  if (!llama || !context) throw new Error('The model is not loaded.');
  const lib = await moduleOnce();
  const key = JSON.stringify(request.schema);
  let grammar = grammars.get(key);
  if (!grammar) {
    // The output can only be what the schema allows, because the grammar limits each token while it is chosen.
    // The schema comes from the engine's own constant, so the cast only tells the compiler what the runtime accepts.
    const schema = request.schema as Parameters<Llama['createGrammarForJsonSchema']>[0];
    grammar = await llama.createGrammarForJsonSchema(schema);
    grammars.set(key, grammar);
  }
  if (loadedTemplate === 'chatml_no_think') {
    // The turn is written out with thinking off. A chat session would let the template turn thinking on.
    const completion = new lib.LlamaCompletion({ contextSequence: context.getSequence() });
    try {
      const text = await completion.generateCompletion(noThinkPrompt(request.system, request.prompt), {
        grammar,
        maxTokens: request.maxTokens,
        temperature: 0,
      });
      return grammar.parse(text);
    } finally {
      completion.dispose({ disposeSequence: true });
    }
  }
  const session = new lib.LlamaChatSession({
    contextSequence: context.getSequence(),
    systemPrompt: request.system,
    autoDisposeSequence: true,
  });
  try {
    const text = await session.prompt(request.prompt, { grammar, maxTokens: request.maxTokens, temperature: 0 });
    return grammar.parse(text);
  } finally {
    session.dispose();
  }
}

function reply(message: WorkerResponse): void {
  process.parentPort.postMessage(message);
}

async function handle(request: WorkerRequest): Promise<void> {
  try {
    if (request.type === 'load') {
      await load(request);
      reply({ type: 'loaded', id: request.id });
    } else {
      reply({ type: 'completed', id: request.id, value: await complete(request) });
    }
  } catch {
    // Failures carry a stage only. Error text can name file paths, so it is never sent to the main process.
    reply({ type: 'failed', id: request.id, stage: request.type === 'load' ? 'load' : 'complete' });
  }
}

/** A malformed message that still has an id is answered as a failure, so the caller never waits on it. */
function refuse(value: unknown): void {
  if (!isRecord(value) || !Number.isInteger(value.id)) return;
  reply({ type: 'failed', id: value.id as number, stage: value.type === 'load' ? 'load' : 'complete' });
}

process.parentPort.on('message', event => {
  const request = parseRequest(event.data);
  // One failed request must not stop the queue behind it.
  if (request) chain = chain.then(() => handle(request)).catch(() => undefined);
  else refuse(event.data);
});
