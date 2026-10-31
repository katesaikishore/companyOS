// Opt-in check: loads nomic-embed-text-v1.5 (Q8_0) through node-llama-cpp, embeds three short strings, and checks the
// vector length and that similar strings score closer than an unrelated one. Prints one JSON report to stdout.
//
// Needs: npm run build -w @companyos/twin-core, and 0.15 GB of disk for the model (see fetch-models.mjs).
// Usage: COMPANYOS_MODEL_CACHE=/path/to/cache node scripts/model-smoke/embed.mjs
// Exit status 1 when a check fails.
import { loadavg } from 'node:os';
import { loadEmbedder } from './embedder.mjs';
import { cosine, ensureModel, machine, memoryOf, round } from './lib.mjs';

const TEXTS = {
  a: 'Open the spreadsheet, then email the weekly report to the team.',
  b: 'After updating the spreadsheet, send the weekly report by email.',
  c: 'The cat slept on the warm windowsill all afternoon.',
};
const EXPECTED_DIMENSIONS = 768;

const { spec, path, dir } = await ensureModel('nomic-embed-text-v1.5');
const loadAverage = () => loadavg().map(value => round(value));
const loadStart = loadAverage();

const started = performance.now();
const embedder = await loadEmbedder({ modelsDir: dir, modelPath: path });
const loadMs = performance.now() - started;
const afterLoad = memoryOf(process.pid);

const vectors = {};
const embedMs = {};
for (const [key, text] of Object.entries(TEXTS)) {
  const begin = performance.now();
  vectors[key] = await embedder.embed(text);
  embedMs[key] = round(performance.now() - begin, 1);
}
// A second pass over the same strings, without the first call's warm-up.
const repeatMs = [];
for (const text of Object.values(TEXTS)) {
  const begin = performance.now();
  await embedder.embed(text);
  repeatMs.push(round(performance.now() - begin, 1));
}
const afterEmbeds = memoryOf(process.pid);

const similar = cosine(vectors.a, vectors.b);
const unrelatedA = cosine(vectors.a, vectors.c);
const unrelatedB = cosine(vectors.b, vectors.c);
const norms = Object.values(vectors).map(vector => Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)));
const finite = Object.values(vectors).every(vector => vector.every(Number.isFinite));

const checks = {
  vectorLengthIs768: Object.values(vectors).every(vector => vector.length === EXPECTED_DIMENSIONS),
  allValuesFinite: finite,
  similarCloserThanUnrelated: similar > unrelatedA && similar > unrelatedB,
};

const report = {
  machine: machine(),
  loadAverageBefore: loadStart,
  loadAverageAfter: loadAverage(),
  model: { id: spec.id, file: spec.file, bytes: spec.sizeBytes, sha256: spec.sha256 },
  texts: TEXTS,
  vectorLength: vectors.a.length,
  vectorNorms: norms.map(norm => round(norm, 3)),
  cosine: { similarPair: round(similar, 4), unrelatedWithA: round(unrelatedA, 4), unrelatedWithB: round(unrelatedB, 4) },
  timings: {
    loadTotalMs: round(loadMs, 0),
    loadModelMs: round(embedder.timings.loadModelMs, 0),
    createContextMs: round(embedder.timings.createContextMs, 0),
    firstThreeEmbedsMs: embedMs,
    repeatThreeEmbedsMs: repeatMs,
  },
  memory: { afterLoad, afterEmbeds },
  checks,
};
await embedder.dispose();
console.log(JSON.stringify(report, null, 2));
process.exit(Object.values(checks).every(Boolean) ? 0 : 1);
