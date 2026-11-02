// Read-only check of the target picker on a real app. It takes one snapshot with agent-desktop, asks the picker which
// element the goal names, and prints the outcome. It never runs an action: a run that the gates would allow is reported,
// and nothing is clicked or typed.
//
// Usage (after `npm run build -w @companyos/twin-core`):
//   node scripts/desktop-picker/pick.mjs --app <name> [--name-stub] "<goal>"
//
// Without --name-stub the model is the one that abstains, which is what runs when Laya is not installed. With --name-stub
// a fixed stub picks the element whose name appears in the goal. The stub only checks the plumbing and the gates, and
// it is not a measure of Laya.
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const appAt = args.indexOf('--app');
if (appAt < 0 || !args[appAt + 1]) throw new Error('Pass --app <name>.');
const app = args[appAt + 1];
const useStub = args.includes('--name-stub');
const goal = args.filter((arg, i) => i !== appAt && i !== appAt + 1 && arg !== '--name-stub').join(' ').trim();
if (!goal) throw new Error('Pass a goal in quotes.');

const raw = execFileSync('agent-desktop', ['snapshot', '--app', app, '-i', '--compact'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const core = fileURLToPath(new URL('../../packages/core/dist/', import.meta.url));
const { candidatesOf, pickTarget } = await import(`${core}picker.js`);
const { AbstainingDecisionModel } = await import(`${core}decision.js`);

const { candidates, truncated } = candidatesOf(JSON.parse(raw));
const DESTRUCTIVE = /delete|remove|trash|empty|erase|send|pay|quit|overwrite/i;
const nameOf = description => (description.match(/"([^"]*)"/) ?? [])[1] ?? '';

const stub = {
  id: 'name-stub',
  async decide(request) {
    if (request.question.kind === 'noul') {
      const hard = DESTRUCTIVE.test(request.state.element ?? '');
      return { status: 'answered', answer: { kind: 'noul', probability: hard ? 0.95 : 0.05, confidence: hard ? 0.95 : 0.95 } };
    }
    const options = request.question.options;
    const hit = options.find(option => option.id !== 'none' && nameOf(option.description ?? '') && goal.toLowerCase().includes(nameOf(option.description).toLowerCase()));
    const chosen = hit?.id ?? 'none';
    const probabilities = Object.fromEntries(options.map(option => [option.id, option.id === chosen ? 0.95 : 0.05 / Math.max(1, options.length - 1)]));
    return { status: 'answered', answer: { kind: 'choice', choice: chosen, probabilities, confidence: 0.95 } };
  },
};

const model = useStub ? stub : new AbstainingDecisionModel();
const outcome = await pickTarget(goal, candidates, model, truncated);
const named = candidates.find(candidate => candidate.ref === outcome.ref);
console.log(JSON.stringify({
  app,
  goal,
  model: model.id,
  actionable_elements: candidates.length,
  truncated,
  outcome: { decision: outcome.decision, reason: outcome.reason, confidence: outcome.confidence, element: named ? `${named.role} "${named.name}"` : undefined },
  action: 'not run: this script never acts',
}, null, 2));
