// Calls the built executor against a real agent-desktop binary and prints timings and key delivery.
// Usage: AGENT_DESKTOP_BIN=/path/to/agent-desktop KEY_LOG=/path/to/keys.log node executor-real.mjs
import { focusWithAgentDesktop, pressWithAgentDesktop } from '../../apps/desktop/dist/main/agent-desktop.js';
import { writeFileSync, readFileSync } from 'node:fs';

const binary = process.env.AGENT_DESKTOP_BIN;
const LOG = process.env.KEY_LOG;
if (!binary || !LOG) throw new Error('Set AGENT_DESKTOP_BIN and KEY_LOG');
const records = [];
const opts = { binary, record: r => records.push(r) };
const timed = async fn => { const s = performance.now(); const r = await fn(); return { r, ms: performance.now() - s }; };
const sorted = xs => [...xs].sort((a, b) => a - b);
const med = xs => Math.round(sorted(xs)[Math.floor(xs.length / 2)]);
const p90 = xs => Math.round(sorted(xs)[Math.floor(0.9 * (xs.length - 1))]);

await timed(() => focusWithAgentDesktop(opts, 'python3.12')); // warm-up
const focusMs = [], pressMs = [], pressOk = [], keys = [];
for (let i = 0; i < 20; i++) {
  writeFileSync(LOG, '');
  focusMs.push((await timed(() => focusWithAgentDesktop(opts, 'python3.12'))).ms);
  const p = await timed(() => pressWithAgentDesktop(opts, 'python3.12', 'ctrl+a'));
  pressMs.push(p.ms); pressOk.push(p.r.ok);
  await new Promise(r => setTimeout(r, 400));
  keys.push(readFileSync(LOG, 'utf8').split('\n').filter(l => l === 'ctrl+a').length);
}
const badChord = await timed(() => pressWithAgentDesktop(opts, 'python3.12', 'notakey'));
const badApp = await timed(() => focusWithAgentDesktop(opts, 'NoSuchApp'));
const noPath = await timed(() => focusWithAgentDesktop({ binary: '' }, 'python3.12'));
console.log(JSON.stringify({
  focus: { n: focusMs.length, medianMs: med(focusMs), p90Ms: p90(focusMs) },
  focus_then_press: { n: pressMs.length, medianMs: med(pressMs), p90Ms: p90(pressMs), ok: pressOk.filter(Boolean).length, keysDelivered: keys.reduce((a, b) => a + b, 0) },
  bad_chord: { result: badChord.r, ms: Math.round(badChord.ms) },
  unknown_app: { result: badApp.r, ms: Math.round(badApp.ms) },
  empty_path: { result: noPath.r, ms: Math.round(noPath.ms) },
  record_count: records.length,
}, null, 2));
