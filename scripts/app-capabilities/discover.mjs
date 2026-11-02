// Asks the installed local model what one running application can do, from its visible controls only.
// Read-only: it takes one accessibility snapshot of the app and runs the model. It never clicks or types.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   node scripts/app-capabilities/discover.mjs --app <name> --model <path to the .gguf>
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getLlama, LlamaChatSession } from 'node-llama-cpp';

const args = process.argv.slice(2);
const flag = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const app = flag('--app');
const modelPath = flag('--model');
if (!app || !modelPath) throw new Error('Pass --app <name> and --model <path to the .gguf>.');

const core = fileURLToPath(new URL('../../packages/core/dist/apps/capabilities.js', import.meta.url));
const { surfaceOf, discoverCapabilities } = await import(core);

const snapshot = JSON.parse(execFileSync('agent-desktop', ['snapshot', '--app', app, '--compact'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }));
const surface = surfaceOf(app, snapshot);
console.error(`${surface.controls.length} controls read for ${app}`);

const llama = await getLlama({ build: 'never' });
const model = await llama.loadModel({ modelPath });
const completer = {
  async complete({ system, prompt, schema, maxTokens, signal }) {
    const context = await model.createContext({ contextSize: 4096 });
    const session = new LlamaChatSession({ contextSequence: context.getSequence(), systemPrompt: system });
    const grammar = await llama.createGrammarForJsonSchema(schema);
    const text = await session.prompt(prompt, { grammar, maxTokens, signal });
    await context.dispose();
    return JSON.parse(text);
  },
};

const started = Date.now();
const result = await discoverCapabilities(completer, surface);
console.log(JSON.stringify({ app, seconds: Math.round((Date.now() - started) / 1000), ...result }, null, 2));
await model.dispose();
