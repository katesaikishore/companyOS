// Checks the Laya kind labels against the app catalogue. Laya sees only an app's name. The catalogue's class for each
// name is the truth, and it is kept from Laya. The same adapter the app uses (LayaDecisionModel) is called, one app at a
// time, with the kind question from the engine. Nothing is written to disk. Prints one JSON report on stdout.
//
// Usage: LAYA_MODEL_DIR=/path/to/bundle node scripts/laya-check/label-eval.mjs > laya-labels.json
// The bundle is the folder that holds laya.onnx, laya_config.json and tokenizer/ (the app's models/laya/... folder, or
// the verified cache used by the real-model tests).
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const core = require('@companyos/twin-core');
const { LayaDecisionModel } = require(path.join(here, '../../apps/desktop/dist/main/decision-laya.js'));
const { Laya } = await import('@receptron/laya');

const dir = process.env.LAYA_MODEL_DIR;
if (!dir) throw new Error('Set LAYA_MODEL_DIR to the bundle folder.');
const started = performance.now();
const laya = await Laya.load({ modelDir: dir });
const loadMs = performance.now() - started;
const model = new LayaDecisionModel({ runtime: async () => laya, timeoutMs: 20_000 });
const question = core.kindQuestion();
const median = xs => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const p90 = xs => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.ceil(0.9 * xs.length) - 1)];
const round = (x, places = 3) => Number(x.toFixed(places));

async function ask(name) {
  const t = performance.now();
  const result = await model.decide({ state: { apps: [name] }, question });
  return { result, ms: performance.now() - t };
}

// Truth: the catalogue's class for the name, as the kind the rules give it. 'Other' is not a truth, because it is the
// label for a name the catalogue does not know.
const truths = core.cataloguedApps()
  .map(name => ({ name, truth: core.ruleKindOfClass(core.classifyApp(name)) }))
  .filter(item => item.truth !== 'Other');

const rows = [];
for (const { name, truth } of truths) {
  const { result, ms } = await ask(name);
  const answer = result.status === 'answered' ? result.answer : undefined;
  rows.push({
    name,
    truth,
    ms,
    abstained: result.status === 'abstained' ? result.reason : undefined,
    choice: answer?.choice,
    confidence: answer?.confidence,
  });
}

const answered = rows.filter(row => row.choice !== undefined);
// What the app would show: a kind other than Other, at or above the engine's threshold.
const shown = answered.filter(row => row.choice !== 'Other' && row.confidence >= core.KIND_MIN_CONFIDENCE);
const correct = rows => rows.filter(row => row.choice === row.truth).length;
const perKind = {};
for (const row of rows) {
  const entry = (perKind[row.truth] ??= { names: 0, shownCorrect: 0, shown: 0 });
  entry.names++;
  if (shown.includes(row)) {
    entry.shown++;
    if (row.choice === row.truth) entry.shownCorrect++;
  }
}
const confusion = {};
for (const row of shown) {
  if (row.choice === row.truth) continue;
  const key = `${row.truth} -> ${row.choice}`;
  confusion[key] = (confusion[key] ?? 0) + 1;
}

const unknown = ['arc', 'linear', 'zed', 'notion', 'obsidian', 'warp', 'ghostty', 'wezterm', 'raycast', 'miro', 'discord', 'telegram', 'postman', 'anki', 'todoist'];
const unknownAnswers = [];
for (const name of unknown) {
  const { result } = await ask(name);
  unknownAnswers.push({
    name,
    label: result.status === 'answered' ? result.answer.choice : undefined,
    confidence: result.status === 'answered' ? round(result.answer.confidence) : undefined,
    abstained: result.status === 'abstained' ? result.reason : undefined,
  });
}

const report = {
  model: { id: model.id, bundle: 'laya', loadMs: round(loadMs, 0) },
  rows: rows.map(({ name, truth, choice, confidence, ms }) => ({ name, truth, choice, confidence: confidence === undefined ? undefined : round(confidence), ms: round(ms, 0) })),
  threshold: core.KIND_MIN_CONFIDENCE,
  names: rows.length,
  answered: answered.length,
  abstained: rows.length - answered.length,
  shown: shown.length,
  coverage: round(shown.length / rows.length),
  accuracyAllAnswered: round(correct(answered) / answered.length),
  accuracyShown: round(correct(shown) / shown.length),
  perKind: Object.fromEntries(Object.entries(perKind).map(([kind, e]) => [kind, { ...e, shownAccuracy: e.shown ? round(e.shownCorrect / e.shown) : null }])),
  confusionShown: confusion,
  latencyMs: { median: round(median(rows.map(row => row.ms)), 0), p90: round(p90(rows.map(row => row.ms)), 0) },
  wrongShown: shown.filter(row => row.choice !== row.truth).map(({ name, truth, choice, confidence }) => ({ name, truth, choice, confidence: round(confidence) })),
  unknownApps: unknownAnswers,
};
console.log(JSON.stringify(report, null, 2));
await laya.close();
