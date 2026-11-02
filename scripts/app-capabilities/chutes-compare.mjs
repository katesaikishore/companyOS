// Runs capability discovery on one saved application surface with several Chutes models, then prints what each proposed,
// how long each call took, and how each proposal would be read. Nothing is clicked or typed.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   CHUTES_API_KEY=... node scripts/app-capabilities/chutes-compare.mjs --app <name> --models <id,id,...> --out <results.json>
//   CHUTES_API_KEY=... node scripts/app-capabilities/chutes-compare.mjs --surface <results.json> --models <id,...> --out <new.json>
// Add --max-tokens <n> to override the app's token budget (800). The results file holds the screen's control names, so do
// not commit it. The key is read from the environment. It is never printed or written to a file.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createChutesCompleter } from './chutes-completer.mjs';
import { createAnthropicCompleter } from './anthropic-completer.mjs';

const args = process.argv.slice(2);
const flag = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const models = (flag('--models') ?? '').split(',').map(id => id.trim()).filter(Boolean);
// --provider anthropic sends the same screen to the Claude API with ANTHROPIC_API_KEY. The default is Chutes.
const provider = flag('--provider') ?? 'chutes';
if (!['chutes', 'anthropic'].includes(provider)) throw new Error('--provider must be chutes or anthropic.');
const apiKey = (process.env[provider === 'anthropic' ? 'ANTHROPIC_API_KEY' : 'CHUTES_API_KEY'] ?? '').trim();
const host = provider === 'anthropic' ? 'api.anthropic.com' : 'llm.chutes.ai';
const out = flag('--out');
if (!args.includes('--off-device')) throw new Error('This harness sends control names to Chutes or Anthropic. Add --off-device to confirm.');
const maxTokens = flag('--max-tokens') ? Number(flag('--max-tokens')) : undefined;
const noThink = args.includes('--no-think');
if (!apiKey) throw new Error('Set the key for this provider in the environment (CHUTES_API_KEY or ANTHROPIC_API_KEY).');
if (models.length === 0) throw new Error('Pass --models with one or more Chutes model ids, comma separated.');
if (!out) throw new Error('Pass --out <file.json>.');

const core = fileURLToPath(new URL('../../packages/core/dist/apps/capabilities.js', import.meta.url));
const { surfaceOf, discoverCapabilities, RISKS } = await import(core);
// The same limits the app's reply check uses (packages/core/src/apps/capabilities.ts).
const ITEMS_MAX = 12;
const NAME_MAX = 80;
const DESCRIPTION_MAX = 240;

let surface;
if (flag('--surface')) {
  const saved = JSON.parse(readFileSync(flag('--surface'), 'utf8'));
  surface = saved.surface ?? saved;
} else if (flag('--app')) {
  const app = flag('--app');
  const snapshot = JSON.parse(execFileSync('agent-desktop', ['snapshot', '--app', app, '--compact'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
  surface = surfaceOf(app, snapshot);
} else {
  throw new Error('Pass --surface <results.json> or --app <name>.');
}
console.error(`Sending ${surface.controls.length} control names for ${surface.app} to ${host}, once per model.`);

// Each proposal is read as one of three kinds. The kinds are a judgment, so every name is printed with its kind.
//   navigation: moves the person around the app, such as opening a tab or screen.
//   setting: changes an option or a switch, which the app's own prompt says is not a job.
//   job: anything else.
const SCREEN_WORDS = /^(overview|home|settings|recall|suggestions|automations|network ledger|ledger|app readiness|what the twin knows)$/i;
const SETTING_WORDS = /\b(choose models|models|appearance|theme|preferences|settings|program path|token|level \d|pause capture|watch browsers|read text on screen|transcribe|keep screen images|local api|allow unattended|exclude|retention)\b/i;
const navNames = surface.controls
  .filter(control => /^(link|tab) "/.test(control))
  .map(control => control.replace(/^(link|tab) "/, '').replace(/"$/, '').replace(/\s+\d+%?$/, '').toLowerCase());
function kindOf(name) {
  const lower = name.toLowerCase().trim();
  if (navNames.includes(lower.replace(/\s+\d+%?$/, ''))) return 'navigation';
  const target = lower.replace(/^(go to|open|view|show|navigate to)\s+(the\s+)?/, '');
  if (target !== lower && SCREEN_WORDS.test(target)) return 'navigation';
  if (SETTING_WORDS.test(name)) return 'setting';
  return 'job';
}

// The reply that failed the app's check, if the model produced one: how many items, and which limit each broke.
function itemIssues(calls) {
  const reply = calls.filter(call => call.ok && call.reply).at(-1)?.reply;
  const items = reply?.capabilities;
  if (!Array.isArray(items)) return null;
  return {
    items: items.length,
    overItemLimit: items.length > ITEMS_MAX,
    longName: items.filter(item => typeof item.name === 'string' && item.name.length > NAME_MAX).length,
    longDescription: items.filter(item => typeof item.description === 'string' && item.description.length > DESCRIPTION_MAX).length,
    badRisk: items.filter(item => !RISKS.includes(item.risk)).length,
  };
}

const results = [];
for (const model of models) {
  const calls = [];
  const completer =
    provider === 'anthropic'
      ? createAnthropicCompleter({ apiKey, model, maxTokens, onResult: call => calls.push(call) })
      : createChutesCompleter({ apiKey, model, maxTokens, noThink, onResult: call => calls.push(call) });
  const started = Date.now();
  const outcome = await discoverCapabilities(completer, surface);
  const seconds = Math.round((Date.now() - started) / 1000);
  const failed = outcome.reason !== undefined;
  const proposals = outcome.capabilities.map(capability => ({
    name: capability.name,
    risk: capability.risk,
    needsApproval: capability.needsApproval,
    kind: kindOf(capability.name),
  }));
  const count = kind => proposals.filter(proposal => proposal.kind === kind).length;
  const row = {
    model,
    budget: calls[0]?.budget ?? maxTokens ?? null,
    seconds,
    reason: outcome.reason ?? null,
    failure: calls.filter(call => !call.ok).at(-1)?.reason ?? null,
    stripped: calls.some(call => call.stripped),
    // Counts are null for a failed call, so a timeout is never read as "no jobs found".
    navigation: failed ? null : count('navigation'),
    setting: failed ? null : count('setting'),
    jobs: failed ? null : count('job'),
    itemIssues: itemIssues(calls),
    proposals,
    calls,
  };
  results.push(row);
  console.error(`${model}: ${failed ? `failed (${row.failure ?? outcome.reason})` : `${proposals.length} proposals`}, ${seconds}s`);
}

writeFileSync(out, JSON.stringify({ surface, provider, maxTokens: maxTokens ?? 'app default (800)', thinking: noThink ? 'off' : 'model default', results }, null, 2));
console.log('model | budget | seconds | status | navigation | setting | jobs | stripped');
for (const row of results) {
  const status = row.reason ? `failed: ${row.failure ?? row.reason}` : 'ok';
  console.log(`${row.model} | ${row.budget} | ${row.seconds} | ${status} | ${row.navigation ?? '-'} | ${row.setting ?? '-'} | ${row.jobs ?? '-'} | ${row.stripped}`);
}
