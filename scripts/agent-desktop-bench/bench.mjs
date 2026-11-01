// Benchmarks agent-desktop against a real GTK 3 test window on Linux (X11). It is started by run.sh, which provides the
// display, the AT-SPI bus and the window manager.
//
// Every trial starts a fresh test window. A trial that loses its window is recorded and kept: nothing is discarded, and
// the call at which the window died is part of the result.
//
// Stages (STAGES, comma separated, default all six):
//   cli                  Times the program's own commands, one test window, CLI_CALLS calls each.
//   names                Asks both mechanisms for the same window under four names (its process name, its window class
//                        in two spellings, its title). companyOS records a Linux app by its window class, and the program
//                        knows it by its process name, so this shows which names each one accepts.
//   production           The path the app takes on Linux when the program path is set: the executor from
//                        handsExecutor(executorFor(platform), ..., 'linux'). Focus goes through the program, and the key
//                        press is the built-in xdotool adapter. The window's class is set equal to its process name, so
//                        both mechanisms accept one name. TRIALS trials of CALLS presses.
//   agent-desktop-press  The program's own press (pressWithAgentDesktop, which runs list-windows, focus-window and then
//                        press), the path that crashed the test window. TRIALS trials of CALLS presses.
//   press-headless       The program's `press <chord> --app <name>` alone, after one focus-window. TRIALS trials of CALLS.
//   press-headed         The same with --headed, which brings the window forward itself. TRIALS trials of CALLS.
//
// Settings from the environment: AGENT_DESKTOP_BIN (required), OUT (a JSON file for the full result), TRIALS (5),
// CALLS (60), CLI_CALLS (30), PYTHON (/usr/bin/python3.12), APP_NAME (the PYTHON file's name, which is the process name
// the program matches on).
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pressWithAgentDesktop, handsExecutor } from '../../apps/desktop/dist/main/agent-desktop.js';
import { choosePlatform, executorFor } from '../../apps/desktop/dist/main/platform.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BIN = process.env.AGENT_DESKTOP_BIN;
if (!BIN) throw new Error('Set AGENT_DESKTOP_BIN');
const PYTHON = process.env.PYTHON ?? '/usr/bin/python3.12';
const APP = process.env.APP_NAME ?? path.basename(PYTHON);
const TRIALS = Number(process.env.TRIALS ?? 5);
const CALLS = Number(process.env.CALLS ?? 60);
const CLI_CALLS = Number(process.env.CLI_CALLS ?? 30);
const STAGES = (process.env.STAGES ?? 'cli,names,production,agent-desktop-press,press-headless,press-headed').split(',');
const OUT = process.env.OUT;
const SETTLE_MS = 150; // After a press, wait this long for the window to log the key and for a crash to show.
const CHORD = 'ctrl+a';

const dir = mkdtempSync(path.join(os.tmpdir(), 'ad-bench-'));
const KEY_LOG = path.join(dir, 'keys.log');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const now = () => performance.now();
const tenth = x => (x === null || x === undefined ? null : Math.round(x * 10) / 10);
/** Nearest-rank percentile of a list of numbers. */
const rank = (xs, q) => {
  const sorted = [...xs].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.max(0, Math.ceil(q * sorted.length) - 1)] : null;
};
const stat = xs => ({
  n: xs.length,
  min: tenth(xs.length ? Math.min(...xs) : null),
  p50: tenth(rank(xs, 0.5)),
  p90: tenth(rank(xs, 0.9)),
  max: tenth(xs.length ? Math.max(...xs) : null),
});

/** One synchronous call of the program, timed. */
function program(args) {
  const started = now();
  const result = spawnSync(BIN, args, { encoding: 'utf8', timeout: 10_000, maxBuffer: 1 << 24 });
  const ms = now() - started;
  let ok = false;
  let code;
  try {
    const envelope = JSON.parse(result.stdout);
    ok = envelope.ok === true;
    code = envelope.error?.code;
  } catch {
    // Not JSON: the call did not produce an envelope, so it did not succeed.
  }
  return { ms, ok, status: result.status, code };
}

const alive = app => app.child.exitCode === null && app.child.signalCode === null;

/** Starts a fresh test window and waits until the program can see it. */
async function startApp(appClass) {
  writeFileSync(KEY_LOG, '');
  const child = spawn(PYTHON, ['-X', 'faulthandler', path.join(HERE, 'testapp.py')], {
    env: { ...process.env, KEY_LOG, ...(appClass ? { APP_CLASS: appClass } : {}) },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr = (stderr + chunk).slice(-4000);
  });
  const app = { child, stderr: () => stderr };
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (!alive(app)) throw new Error(`the test window exited while starting: ${stderr.slice(-400)}`);
    if (program(['list-windows', '--app', APP]).ok) {
      await sleep(500);
      return app;
    }
    await sleep(300);
  }
  child.kill('SIGKILL');
  throw new Error('the test window did not appear within 20 s');
}

async function stopApp(app) {
  if (alive(app)) {
    const exited = new Promise(resolve => app.child.once('exit', resolve));
    app.child.kill('SIGKILL');
    await exited;
  }
  await sleep(500);
}

const keysSeen = () => readFileSync(KEY_LOG, 'utf8').split('\n').filter(line => line === CHORD).length;

function environment() {
  const out = (cmd, args) => {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 10_000 });
    return (r.stdout || r.stderr || '').trim().split('\n')[0];
  };
  const gtk = spawnSync(PYTHON, ['-c', "import gi; gi.require_version('Gtk','3.0'); from gi.repository import Gtk; print(f'{Gtk.get_major_version()}.{Gtk.get_minor_version()}.{Gtk.get_micro_version()}')"], { encoding: 'utf8' });
  return {
    recordedAt: new Date().toISOString(),
    os: (readFileSync('/etc/os-release', 'utf8').match(/^PRETTY_NAME="?([^"\n]*)/m) ?? [])[1] ?? 'unknown',
    kernel: `${os.type()} ${os.release()}`,
    cpu: `${os.cpus()[0]?.model ?? 'unknown'}`,
    logicalCpus: os.cpus().length,
    memoryMiB: Math.round(os.totalmem() / 1048576),
    node: process.version,
    agentDesktop: out(BIN, ['--version']),
    atSpi2Core: out('dpkg-query', ['-W', '-f=${Version}', 'at-spi2-core']),
    openbox: out('dpkg-query', ['-W', '-f=${Version}', 'openbox']),
    xdotool: out('dpkg-query', ['-W', '-f=${Version}', 'xdotool']),
    xvfb: out('dpkg-query', ['-W', '-f=${Version}', 'xvfb']),
    gtk: (gtk.stdout || '').trim(),
    python: out(PYTHON, ['--version']),
    appName: APP,
    loadAverageAtStart: os.loadavg().map(tenth),
  };
}

async function cliStage() {
  const app = await startApp();
  const commands = [
    ['status'],
    ['list-apps', '--app', APP],
    ['list-windows', '--app', APP],
    ['snapshot', '--app', APP, '-i'],
    ['focus-window', '--app', APP],
  ];
  const rows = [];
  for (const args of commands) {
    const first = program(args); // The first call of each command is kept apart: it warms caches.
    const times = [];
    let ok = 0;
    for (let i = 0; i < CLI_CALLS; i++) {
      const r = program(args);
      times.push(r.ms);
      if (r.ok) ok++;
    }
    rows.push({ command: args.join(' '), firstMs: tenth(first.ms), ...stat(times), ok, of: CLI_CALLS });
  }
  const survived = alive(app);
  await stopApp(app);
  return { rows, windowSurvived: survived, loadAverage: os.loadavg().map(tenth) };
}

/**
 * The same window under four names. The window is left with its natural class, so the class differs from the process name.
 * The program is asked to focus it. The built-in Linux adapter is asked to press a key in it, which it does only when the
 * name is the window's class, and the key log shows whether anything arrived.
 */
async function namesStage() {
  const choice = await choosePlatform();
  if (!choice.platform?.pressShortcut) throw new Error(`no Linux press adapter: ${choice.detail}`);
  const app = await startApp();
  const frontmost = await choice.platform.frontmost();
  const candidates = [
    ['process name', APP],
    ['window class as the adapter reports it', frontmost],
    ['window class in lower case', frontmost?.toLowerCase()],
    ['window title', 'ADTestApp'],
  ];
  const rows = [];
  for (const [what, name] of candidates) {
    if (!name) continue;
    const focus = program(['focus-window', '--app', name]);
    writeFileSync(KEY_LOG, '');
    const pressed = await choice.platform.pressShortcut(name, CHORD);
    await sleep(SETTLE_MS);
    rows.push({ name, what, agentDesktopFocusOk: focus.ok, agentDesktopFocusError: focus.code ?? null, builtInPressOk: pressed, keysDelivered: keysSeen() });
  }
  const survived = alive(app);
  await stopApp(app);
  return { frontmostAsAdapterReports: frontmost, rows, windowSurvived: survived };
}

/** One trial: a fresh window and up to CALLS presses. It stops at the first press after which the window is gone. */
async function pressTrial(kind, exec, options) {
  const app = await startApp(APP);
  if (kind === 'press-headless') program(['focus-window', '--app', APP]); // Headless press needs the window in front.
  const calls = [];
  let diedAtCall = null;
  for (let i = 1; i <= CALLS; i++) {
    writeFileSync(KEY_LOG, '');
    const call = { i };
    try {
      if (kind === 'production') {
        let t = now();
        call.focusOk = await exec.focusApp(APP);
        call.focusMs = now() - t;
        t = now();
        call.pressOk = await exec.pressShortcut(APP, CHORD);
        call.pressMs = now() - t;
      } else if (kind === 'press-headless' || kind === 'press-headed') {
        const r = program(['press', CHORD, '--app', APP, ...(kind === 'press-headed' ? ['--headed'] : [])]);
        call.pressMs = r.ms;
        call.pressOk = r.ok;
      } else {
        const t = now();
        const result = await pressWithAgentDesktop(options, APP, CHORD);
        call.pressMs = now() - t;
        call.pressOk = result.ok;
        if (!result.ok) call.failure = result.failure;
      }
    } catch (error) {
      call.pressOk = false;
      call.error = String(error?.message ?? error).slice(0, 120);
    }
    await sleep(SETTLE_MS);
    call.keys = keysSeen();
    call.windowAlive = alive(app);
    calls.push(call);
    if (!call.windowAlive) {
      diedAtCall = i;
      break;
    }
  }
  const exit = alive(app) ? null : { code: app.child.exitCode, signal: app.child.signalCode };
  const fatal = /Segmentation fault|Fatal Python error/.test(app.stderr());
  await stopApp(app);
  const timed = calls.filter(c => c.i > 1);
  return {
    callsMade: calls.length,
    diedAtCall,
    exit,
    faulthandlerReportedFatalError: fatal,
    pressOk: calls.filter(c => c.pressOk).length,
    callsWithOneKey: calls.filter(c => c.keys === 1).length,
    keysDelivered: calls.reduce((sum, c) => sum + c.keys, 0),
    firstPressMs: tenth(calls[0]?.pressMs ?? null),
    pressMs: stat(timed.map(c => c.pressMs)),
    ...(kind === 'production' ? { focusMs: stat(timed.map(c => c.focusMs)), focusOk: calls.filter(c => c.focusOk).length } : {}),
    calls,
  };
}

async function pressStage(kind) {
  const records = [];
  const options = { binary: BIN, record: r => records.push(r) };
  let exec;
  if (kind === 'production') {
    const choice = await choosePlatform();
    if (!choice.platform) throw new Error(`no Linux platform adapter: ${choice.detail}`);
    exec = handsExecutor(executorFor(choice.platform), options, 'linux');
    if (!exec.pressShortcut) throw new Error('the Linux adapter has no pressShortcut (xdotool or xprop missing?)');
  }
  const loadAverage = os.loadavg().map(tenth);
  const trials = [];
  for (let t = 1; t <= TRIALS; t++) trials.push({ trial: t, ...(await pressTrial(kind, exec, options)) });
  const died = trials.filter(t => t.diedAtCall !== null);
  return {
    loadAverageAtStart: loadAverage,
    trials: trials.length,
    windowDied: died.length,
    diedAtCalls: died.map(t => t.diedAtCall),
    callsMade: trials.reduce((s, t) => s + t.callsMade, 0),
    pressOk: trials.reduce((s, t) => s + t.pressOk, 0),
    keysDelivered: trials.reduce((s, t) => s + t.keysDelivered, 0),
    perTrial: trials,
  };
}

const result = { config: { stages: STAGES, trials: TRIALS, calls: CALLS, cliCalls: CLI_CALLS, chord: CHORD, settleMs: SETTLE_MS }, environment: environment(), stages: {} };
for (const stage of STAGES) {
  console.error(`[bench] stage ${stage}`);
  if (stage === 'cli') result.stages.cli = await cliStage();
  else if (stage === 'names') result.stages.names = await namesStage();
  else if (stage === 'production') result.stages.production = await pressStage('production');
  else if (['agent-desktop-press', 'press-headless', 'press-headed'].includes(stage)) result.stages[stage] = await pressStage(stage);
  else throw new Error(`unknown stage ${stage}`);
}

if (OUT) writeFileSync(OUT, JSON.stringify(result, null, 2));
// A short summary on stdout. The per-call data is in OUT.
const summary = { config: result.config, environment: result.environment, stages: {} };
if (result.stages.cli) summary.stages.cli = result.stages.cli;
if (result.stages.names) summary.stages.names = result.stages.names;
for (const name of ['production', 'agent-desktop-press', 'press-headless', 'press-headed']) {
  const s = result.stages[name];
  if (!s) continue;
  summary.stages[name] = {
    trials: s.trials,
    windowDied: s.windowDied,
    diedAtCalls: s.diedAtCalls,
    callsMade: s.callsMade,
    pressOk: s.pressOk,
    keysDelivered: s.keysDelivered,
    perTrial: s.perTrial.map(({ calls, ...rest }) => rest),
  };
}
console.log(JSON.stringify(summary, null, 2));
