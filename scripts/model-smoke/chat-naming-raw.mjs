// Names the 60 synthetic routines with a model whose chat template switches thinking on by default (Qwen 3.5). The
// template is written out by hand, with an empty thinking block, and the name is grammar-constrained by the app's own
// JSON schema. It writes the same report shape that score-names.py reads. The app's worker uses a chat session instead, so
// this measures the model with thinking off, which is what naming needs. Usage:
//   COMPANYOS_MODEL_CACHE=... COMPANYOS_CHAT_MODEL=qwen3.5-2b node scripts/model-smoke/chat-naming-raw.mjs > out.json
import { performance } from 'node:perf_hooks';
import { core, ensureModel, syntheticRoutines } from './lib.mjs';

const { getLlama, LlamaCompletion } = await import(new URL('../../node_modules/node-llama-cpp/dist/index.js', import.meta.url).href);
const log = (...parts) => console.error(...parts);
const MODEL = process.env.COMPANYOS_CHAT_MODEL ?? 'qwen3.5-2b';
const { spec, path } = await ensureModel(MODEL, log);
const llama = await getLlama({ gpu: false });
const model = await llama.loadModel({ modelPath: path });
const context = await model.createContext({ contextSize: 2048, threads: Math.max(1, Math.floor(llama.cpuMathCores / 2)) });
const grammar = await llama.createGrammarForJsonSchema(core.ROUTINE_NAME_JSON_SCHEMA);
const completion = new LlamaCompletion({ contextSequence: context.getSequence() });
const describe = routine => routine.steps.map(step => step.app).join(' > ');
const names = [];
const times = [];
for (const routine of syntheticRoutines(60)) {
  const prompt = `<|im_start|>system\n${core.NAMING_SYSTEM_PROMPT}<|im_end|>\n<|im_start|>user\n${core.namingPrompt(routine)}<|im_end|>\n<|im_start|>assistant\n<think>\n\n</think>\n\n`;
  const started = performance.now();
  let raw;
  let outcome;
  try {
    const text = await completion.generateCompletion(prompt, { grammar, maxTokens: 64, temperature: 0 });
    raw = grammar.parse(text);
    const checked = core.RoutineNameOutputSchema.safeParse(raw);
    outcome = checked.success ? 'passes' : 'invalid_output';
  } catch {
    outcome = 'model_error';
  }
  const ms = performance.now() - started;
  times.push(ms);
  names.push({ steps: describe(routine), raw: raw ?? null, outcome, ms: Math.round(ms) });
  log(`${describe(routine)} -> ${JSON.stringify(raw)} ${outcome} ${Math.round(ms)} ms`);
}
const tally = names.reduce((acc, row) => ((acc[row.outcome] = (acc[row.outcome] ?? 0) + 1), acc), {});
const sorted = [...times].sort((a, b) => a - b);
console.log(JSON.stringify({
  model: { id: spec.id, file: spec.file, bytes: spec.sizeBytes, sha256: spec.sha256 },
  template: 'thinking switched off with an empty think block, grammar from ROUTINE_NAME_JSON_SCHEMA',
  wideSample: { names, tally, callMs: { median: Math.round(sorted[Math.floor(sorted.length / 2)]), p90: Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(0.9 * sorted.length) - 1)]) } },
  loadAverageAtEnd: llama.cpuMathCores ? undefined : undefined,
}, null, 2));
await model.dispose?.();
