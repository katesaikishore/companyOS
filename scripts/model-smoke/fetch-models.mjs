// Downloads the catalogue models the real-model checks need into the cache, and verifies them.
// Usage: node scripts/model-smoke/fetch-models.mjs [model-id ...]
// Default: qwen3-0.6b (0.64 GB) and nomic-embed-text-v1.5 (0.15 GB).
import { cacheDir, ensureModel } from './lib.mjs';

const ids = process.argv.length > 2 ? process.argv.slice(2) : ['qwen3-0.6b', 'nomic-embed-text-v1.5'];
console.error(`cache: ${cacheDir()}`);
for (const id of ids) await ensureModel(id);
