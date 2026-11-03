// The whole chain on this Mac, with real apps and real local models:
//   1. two work documents are opened in TextEdit, and the twin reads each window's text as capture does (accessibility text)
//   2. the reads are stored in a real encrypted twin store, then read back with the Recall search
//   3. the reads are embedded on this Mac (Ollama all-minilm) and grouped by meaning
//   4. the local model (Ollama qwen3:4b-instruct, Q4) says what the work is and proposes one task per group
//   5. agent-desktop does the top task in TextEdit, step by step, planned by the same model under the operator's checks
//   6. the window is read again to show what changed
// Nothing leaves this Mac: every model call goes to 127.0.0.1 and is written to the store's ledger.
//
// Usage (after `npm run build -w @companyos/twin-core` and `npx tsc -p apps/desktop/tsconfig.main.json`):
//   node scripts/understand/e2e.mjs [--task 1] [--agent-desktop /opt/homebrew/bin/agent-desktop] [--max-steps 12] [--out report.json]
// It needs Ollama running with qwen3:4b-instruct-2507-q4_K_M and all-minilm pulled, and Accessibility access for the terminal.
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const flag = name => (args.indexOf(name) >= 0 ? args[args.indexOf(name) + 1] : undefined);
const binary = flag('--agent-desktop') ?? '/opt/homebrew/bin/agent-desktop';
const maxSteps = Number(flag('--max-steps') ?? 12);
const out = flag('--out');
/** Which proposal to run, counting from 1. */
const pick = Number(flag('--task') ?? 1);

const load = file => import(fileURLToPath(new URL(file, import.meta.url)));
const { TwinAgent, proposeTasks, runTask } = await load('../../packages/core/dist/index.js');
const { readAccessibleText } = await load('../../apps/desktop/dist/main/accessibility.js');
const { createOllamaChat, createOllamaEmbedder } = await load('../../apps/desktop/dist/main/vision-ollama.js');
const { agentDesktopHands } = await load('../../apps/desktop/dist/main/operator-hands.js');
const { AgentDesktopSession, cursorFor, cursorLabel } = await load('../../apps/desktop/dist/main/agent-desktop.js');

const DOCUMENTS = {
  'Vendor review - Acme.txt': [
    'Vendor review - Acme Supplies, 3 November',
    'Attendees: Priya Shah, Sam Lee',
    'Decision: renew the Acme contract for 12 months at the revised price of 4,200 per month.',
    'Action items:',
    '- Priya: send Acme the signed renewal by Friday',
    '- Sam: confirm the delivery schedule with the warehouse',
    'Open: nobody owns booking the Q4 check-in call with Acme yet.',
  ].join('\n'),
  'Release notes 2.4.txt': [
    'Mobile app 2.4 release notes (draft)',
    'New: sign in with a passkey.',
    'Fixed: the invoice list no longer jumps to the top after a refresh.',
    'TODO: add a line for the faster photo upload (about twice as fast on 4G).',
  ].join('\n'),
};

const log = (...parts) => console.error('[understand]', ...parts);

/** Closes this script's own documents in TextEdit, by name and without saving. Other documents are left alone. */
function closeOurDocuments() {
  const names = Object.keys(DOCUMENTS).map(name => JSON.stringify(name)).join(', ');
  const script = `tell application "TextEdit"\nrepeat with n in {${names}}\nclose (every document whose name is (n as text)) saving no\nend repeat\nend tell`;
  try {
    execFileSync('osascript', ['-e', script]);
  } catch {}
}
closeOurDocuments();
const work = mkdtempSync(path.join(tmpdir(), 'companyos-understand-'));
const report = { reads: [], proposals: [], run: undefined, before: '', after: '', ledger: [] };
const agent = new TwinAgent({ dataDir: path.join(work, 'twin'), dataKey: randomBytes(32) });
try {
  agent.updateConfig({ screenCaptureEnabled: true });

  // 1-2. Open each document, read its window as capture does, and store the read. Each window is read twice, a few seconds
  // apart, as the capture timer would.
  for (const [name, text] of Object.entries(DOCUMENTS)) {
    const file = path.join(work, name);
    writeFileSync(file, text);
    execFileSync('open', ['-a', 'TextEdit', file]);
    await new Promise(resolve => setTimeout(resolve, 2500));
    for (let tick = 0; tick < 2; tick++) {
      const read = await readAccessibleText();
      const stored = agent.ingestScreen({ ts: Date.now(), app: 'TextEdit', windowClass: 'document', text: read, mediaId: null });
      report.reads.push({ document: name, chars: read.length, stored });
      log(`read ${name}: ${read.length} characters, stored=${stored}`);
      await new Promise(resolve => setTimeout(resolve, 1500));
    }
  }
  if (!report.reads.some(read => read.stored)) throw new Error('No window text was read. Give the terminal Accessibility access, then run again.');

  const to = Date.now();
  const hits = agent.searchCapture({ text: '', kind: 'screen', from: to - 3_600_000, to });
  log(`Recall search returned ${hits.length} stored reads`);

  // 3-4. Embed, group, understand, propose.
  const record = entry => agent.recordNetworkCall(entry);
  const started = Date.now();
  const proposals = await proposeTasks(hits, {
    embedder: createOllamaEmbedder({ record }),
    // The same 4B model understands and plans, so only one model is in memory. The 2B vision model was tried here and
    // proposed "Open the document for editing" for the vendor review.
    model: createOllamaChat({ record }),
    excludedApps: agent.configuration.excludedApps,
  });
  report.proposals = proposals;
  log(`understood in ${Math.round((Date.now() - started) / 1000)} s:`);
  for (const task of proposals) log(`  - [${task.app}, ${task.evidence} reads] ${task.topic}: ${task.goal}`);
  if (proposals.length === 0) throw new Error('The model proposed no task.');

  // 5. The operator does the top task. TextEdit steps run on their own; anything that would send or lose work is held and
  // refused here, as no person is answering.
  const task = proposals[pick - 1];
  if (!task) throw new Error(`There is no proposal ${pick}.`);
  // The proposal names its work in words. The document that shares the most of those words is brought to the front.
  const words = new Set(`${task.topic} ${task.goal}`.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []);
  const score = name => (name.toLowerCase().match(/[a-z0-9]{4,}/g) ?? []).filter(word => words.has(word)).length;
  const document = Object.keys(DOCUMENTS).sort((a, b) => score(b) - score(a)).find(name => score(name) > 0);
  if (document) execFileSync('open', ['-a', 'TextEdit', path.join(work, document)]);
  await new Promise(resolve => setTimeout(resolve, 1500));
  report.before = await readAccessibleText();
  // The task's named cursor is drawn on screen, as in the app.
  const session = new AgentDesktopSession(() => ({ binary }));
  const hands = agentDesktopHands(binary, undefined, { session, cursor: cursorFor('operator-task', cursorLabel('companyOS', task.goal)) });
  const runStarted = Date.now();
  const result = await runTask({ goal: task.goal, app: 'TextEdit' }, createOllamaChat({ record }), hands, {
    excludedApps: agent.configuration.excludedApps,
    maxSteps,
    approve: async (action, why) => {
      log(`  held for the person: ${action.type} (${why}). Not approved in this runner.`);
      return false;
    },
    onStep: step => {
      const action = step.action;
      const detail = !action ? '' : action.type === 'type' ? ` ${action.ref} "${action.text}"` : action.ref ? ` ${action.ref}` : action.keys ? ` ${action.keys}` : '';
      log(`  ${step.n}. ${action?.type ?? 'invalid'}${detail} -> ${step.error ?? step.delivery ?? step.verdict ?? ''}`);
    },
  });
  // Ending the session takes the cursor off the screen.
  await session.end();
  report.run = { goal: task.goal, status: result.status, summary: result.summary, steps: result.steps.length, detail: result.steps.map(step => ({ n: step.n, action: step.action?.type, delivery: step.delivery, error: step.error, reply: step.reply })), seconds: Math.round((Date.now() - runStarted) / 1000) };
  log(`run: ${result.status} in ${report.run.seconds} s, ${result.steps.length} steps. ${result.summary ?? ''}`);

  // 6. What changed in the window.
  report.after = await readAccessibleText();
  const before = new Set(report.before.split('\n'));
  const added = report.after.split('\n').filter(line => line.trim() && !before.has(line));
  log(`lines added in the window: ${added.length ? added.map(line => JSON.stringify(line)).join(', ') : 'none'}`);
  report.added = added;
  report.ledger = agent.networkLedger().map(({ purpose, host, path: where, bytes, outcome }) => ({ purpose, host, path: where, bytes, outcome }));
  log(`ledger: ${report.ledger.length} calls, hosts ${[...new Set(report.ledger.map(entry => entry.host))].join(', ')}`);
} finally {
  agent.close();
  if (out) writeFileSync(out, JSON.stringify(report, null, 2));
  // The documents stay open in TextEdit for the person to look at. Close them without saving to discard them.
  rmSync(path.join(work, 'twin'), { recursive: true, force: true });
}
