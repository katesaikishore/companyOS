// The nomic-embed-text v1.5 embedder for the workbook search benchmark, run through node-llama-cpp. Documents and queries
// get nomic's own prefixes. Long rows are cut before they are embedded, so one row cannot overflow the model's context.
import { getLlama } from 'node-llama-cpp';

const CHARACTER_LIMIT = 4000;

/** Loads the GGUF model and returns an embedder for the search. The model file is never downloaded here. */
export async function createNomicEmbedder(modelPath) {
  if (!modelPath) throw new Error('Pass --model <path to nomic-embed-text-v1.5.Q8_0.gguf>.');
  const llama = await getLlama({ build: 'never' });
  const model = await llama.loadModel({ modelPath });
  const context = await model.createEmbeddingContext({ contextSize: 2048 });
  return {
    async embed(texts, role) {
      const prefix = role === 'query' ? 'search_query: ' : 'search_document: ';
      const vectors = [];
      for (const text of texts) {
        const embedding = await context.getEmbeddingFor(prefix + text.slice(0, CHARACTER_LIMIT));
        vectors.push(Array.from(embedding.vector));
      }
      return vectors;
    },
  };
}
