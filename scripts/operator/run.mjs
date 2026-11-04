// Runs one task with the desktop operator on this Mac: agent-desktop is the hands, and a model picks each step.
// Steps that may send, share, spend or lose work are not approved here, so the run stops at the first one.
//
// Usage (after `npm run build -w @companyos/twin-core` and `npx tsc -p apps/desktop/tsconfig.main.json`):
//   node scripts/operator/run.mjs --app TextEdit --goal "..." [--provider ollama|chutes] [--model id] [--max-steps 12] [--out run.json]
// The chutes provider sends the goal and the app's control names to llm.chutes.ai, so it also needs --off-device.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const goal = flag('--goal');
const app = flag('--app');
const provider = flag('--provider') ?? 'ollama';
const maxSteps = Number(flag('--max-steps') ?? 12);
if (!Number.isInteger(maxSteps) || maxSteps < 1 || maxSteps > 50) throw new Error('Pass --max-steps as a whole number from 1 to 50.');
const out = flag('--out');
const binary = flag('--agent-desktop') ?? '/opt/homebrew/bin/agent-desktop';
if (!goal || !app) throw new Error('Pass --goal "<task>" and --app <application>.');

const load = path => import(fileURLToPath(new URL(path, import.meta.url)));
const { runTask } = await load('../../packages/core/dist/operator/loop.js');
const { judge } = await load('../../packages/core/dist/operator/actions.js');
const { DEFAULT_CONFIG } = await load('../../packages/core/dist/types.js');
const { agentDesktopHands } = await load('../../apps/desktop/dist/main/operator-hands.js');
const { AgentDesktopSession, cursorFor, cursorLabel } = await load('../../apps/desktop/dist/main/agent-desktop.js');

/** A model on the Ollama server on this Mac, with hidden reasoning off. Nothing leaves the device. */
function ollamaModel(model) {
  return {
    async complete({ system, prompt, schema, maxTokens, signal }) {
      const response = await fetch('http://127.0.0.1:11434/api/chat', {
        method: 'POST',
        redirect: 'error',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model,
          stream: false,
          think: false,
          format: schema,
          options: { temperature: 0, num_predict: maxTokens },
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: prompt },
          ],
        }),
        signal,
      });
      if (!response.ok) throw new Error(`Ollama returned ${response.status}.`);
      const body = await response.json();
      return JSON.parse(body.message?.content ?? '');
    },
  };
}

async function chutesModel(model) {
  if (!args.includes('--off-device')) throw new Error('The chutes provider sends control names off this Mac. Add --off-device to confirm.');
  const { createChutesCompleter } = await load('../app-capabilities/chutes-completer.mjs');
  return createChutesCompleter({
    apiKey: (process.env.CHUTES_API_KEY ?? '').trim(),
    model,
    noThink: true,
    maxTokens: 600,
    onResult: call => console.error(`  model call: ${JSON.stringify({ ok: call.ok, reason: call.reason, status: call.status, finish: call.finish, tokens: call.tokens, ms: call.ms })}`),
  });
}

const model =
  provider === 'chutes'
    ? await chutesModel(flag('--model') ?? 'Qwen/Qwen3.5-397B-A17B-TEE')
    : ollamaModel(flag('--model') ?? 'qwen3-vl:2b-instruct');

// The start app is checked before it is opened, so an excluded app or a shell is never launched or read.
const start = judge({ type: 'focus_app', app, reason: 'start' }, { app, controls: [] }, { excludedApps: DEFAULT_CONFIG.excludedApps });
if (start.verdict === 'deny') throw new Error(start.why);
// The task's named cursor is drawn on screen, as in the app.
const session = new AgentDesktopSession(() => ({ binary }));
const hands = agentDesktopHands(binary, undefined, { session, cursor: cursorFor('operator-task', cursorLabel('companyOS', goal)) });
// The task starts with the app open. A launch is a local step that sends nothing.
await hands.act({ type: 'launch', app, reason: 'open the app for the task' }, { app, controls: [] });

const started = Date.now();
const result = await runTask({ goal, app }, model, hands, {
  excludedApps: DEFAULT_CONFIG.excludedApps,
  maxSteps,
  approve: async (action, why) => {
    console.error(`  held for the person: ${action.type} (${why}). Not approved in this runner.`);
    return false;
  },
  onStep: step => {
    const action = step.action;
    const detail = !action ? '' : action.type === 'type' ? ` ${action.ref} "${action.text}"` : action.ref ? ` ${action.ref}` : action.keys ? ` ${action.keys}` : action.app ? ` ${action.app}` : '';
    console.error(`  ${step.n}. ${action?.type ?? 'invalid'}${detail} -> ${step.error ?? step.delivery ?? step.verdict ?? ''}${step.code ? ` (${step.code})` : ''}`);
  },
});
// Ending the session takes the cursor off the screen.
await session.end();
const seconds = Math.round((Date.now() - started) / 1000);
console.log(JSON.stringify({ provider, status: result.status, summary: result.summary, steps: result.steps.length, seconds }));
if (out) writeFileSync(out, JSON.stringify({ goal, app, provider, seconds, ...result }, null, 2));
