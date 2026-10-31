// Loads the embedding model (nomic-embed-text-v1.5, Q8_0, from the catalogue) through node-llama-cpp and embeds text.
// Opt-in and not part of the app: nothing in the product calls this, and no product decision uses an embedding.
//
// Like the chat worker, it runs from prebuilt binaries only (build 'never', no download) and loads only a .gguf file
// inside the models folder, after symbolic links are followed. It makes no network call.
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { core, repoRoot } from './lib.mjs';

/** nomic-embed-text-v1.5 was trained with a task prefix on every text. "clustering: " suits grouping similar items. */
export const EMBED_PREFIX = 'clustering: ';

/**
 * @param {{ modelsDir: string, modelPath: string, contextSize?: number }} options
 * @returns {Promise<{ embed(text: string): Promise<number[]>, timings: { loadModelMs: number, createContextMs: number }, dispose(): Promise<void> }>}
 */
export async function loadEmbedder({ modelsDir, modelPath, contextSize = 512 }) {
  const path = await core.resolveModelPath(modelsDir, modelPath);
  // node-llama-cpp is an ES module and a dependency of the desktop app. Resolve it from there, as the app does.
  const entry = createRequire(join(repoRoot, 'apps', 'desktop', 'package.json')).resolve('node-llama-cpp');
  const lib = await import(pathToFileURL(entry).href);
  const llama = await lib.getLlama({
    build: 'never',
    skipDownload: true,
    progressLogs: false,
    logLevel: lib.LlamaLogLevel.disabled,
    logger: () => undefined,
  });
  const loadStart = performance.now();
  const model = await llama.loadModel({ modelPath: path });
  const loadModelMs = performance.now() - loadStart;
  const contextStart = performance.now();
  const context = await model.createEmbeddingContext({ contextSize });
  const createContextMs = performance.now() - contextStart;
  return {
    timings: { loadModelMs, createContextMs },
    embed: async text => [...(await context.getEmbeddingFor(EMBED_PREFIX + text)).vector],
    dispose: async () => {
      await context.dispose();
      await model.dispose();
      await llama.dispose();
    },
  };
}
