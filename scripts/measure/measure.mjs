#!/usr/bin/env node
// Measures the CPU and memory of the built app against the budgets in docs/plan §5.5: average CPU under 1%, RSS under
// 150 MB. It launches the built app with its own data folder, seeds synthetic activity through a test-only hook, and
// samples every process the app starts. Run `node scripts/measure/measure.mjs --help` for the options.
import { spawn, execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, homedir, platform as currentPlatform, release, tmpdir, totalmem, type as osType } from 'node:os';
import { join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { cpuPercent, descendantsOf, readProcessTable, sumRss } from './sampler.mjs';
import { BUDGETS, MIB, evaluate, summarize, toMarkdown } from './report.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const DESKTOP = join(ROOT, 'apps', 'desktop');
const STARTUP_TIMEOUT_MS = 60_000;
const STOP_TIMEOUT_MS = 15_000;

const USAGE = `Usage: node scripts/measure/measure.mjs [options]

Launches the built app (run "npm run build" first) with a fresh data folder, seeds synthetic activity, and samples the
CPU and memory of every process the app starts. Writes a JSON file and a markdown table to the output folder.

Options:
  --duration <s>      Measured window in seconds. Default 1800, the 30-minute gate in the plan.
  --interval <s>      Seconds between samples. Default 5.
  --warmup <s>        Seconds after startup before sampling begins. Default 60, because startup settles over about 30 s.
  --seed-days <n>     Days of synthetic app switches to seed, 0 to 30. Default 10. 0 seeds nothing.
  --capture <mode>    real: the platform's own app capture (the default). fake: a file-based test platform.
  --out <dir>         Folder for the results. Default ./measure-results.
  --user-data <dir>   Data folder to use. It must be new or empty, and outside the app's own data folders.
                      Default: a fresh temporary folder, removed afterwards.
  --keep-data         Keep the temporary data folder for inspection.
  --help              Show this message.
`;

/** Reads the command line. Throws with a message a person can act on. */
export function parseArgs(argv) {
  const options = {
    duration: 1800,
    interval: 5,
    warmup: 60,
    seedDays: 10,
    capture: 'real',
    out: resolve('measure-results'),
    userData: undefined,
    keepData: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    const next = () => {
      index++;
      if (argv[index] === undefined) throw new Error(`${flag} needs a value.`);
      return argv[index];
    };
    switch (flag) {
      case '--duration':
        options.duration = wholeNumber(flag, next(), 1);
        break;
      case '--interval':
        options.interval = wholeNumber(flag, next(), 1);
        break;
      case '--warmup':
        options.warmup = wholeNumber(flag, next(), 0);
        break;
      case '--seed-days':
        options.seedDays = wholeNumber(flag, next(), 0, 30);
        break;
      case '--capture': {
        const mode = next();
        if (mode !== 'real' && mode !== 'fake') throw new Error('--capture must be real or fake.');
        options.capture = mode;
        break;
      }
      case '--out':
        options.out = resolve(next());
        break;
      case '--user-data':
        options.userData = resolve(next());
        break;
      case '--keep-data':
        options.keepData = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`Unknown option ${flag}. Run with --help to see the options.`);
    }
  }
  if (options.duration < options.interval) throw new Error('--duration must be at least --interval.');
  return options;
}

function wholeNumber(flag, text, min, max = Number.POSITIVE_INFINITY) {
  const value = Number(text);
  if (!Number.isInteger(value) || value < min || value > max) {
    const range = max === Number.POSITIVE_INFINITY ? `at least ${min}` : `from ${min} to ${max}`;
    throw new Error(`${flag} must be a whole number ${range}.`);
  }
  return value;
}

/**
 * True when the folder is the app's own data folder or lies inside one. Measured runs must never use those.
 * The path rules are the target OS's, so a Windows path is checked the Windows way wherever the check runs.
 */
export function isInsideAppData(folder, { home, platform: os, env }) {
  const pathApi = os === 'win32' ? win32 : posix;
  const roots =
    os === 'darwin'
      ? [pathApi.join(home, 'Library', 'Application Support')]
      : os === 'win32'
        ? [env.APPDATA, env.LOCALAPPDATA].filter(Boolean)
        : [env.XDG_CONFIG_HOME ?? pathApi.join(home, '.config')];
  return roots.some(root => {
    const path = pathApi.relative(pathApi.resolve(root), pathApi.resolve(folder));
    return path === '' || (!pathApi.isAbsolute(path) && path !== '..' && !path.startsWith(`..${pathApi.sep}`));
  });
}

function prepareDataFolder(requested) {
  if (requested === undefined) {
    return { folder: mkdtempSync(join(tmpdir(), 'companyos-measure-')), temporary: true };
  }
  if (isInsideAppData(requested, { home: homedir(), platform: currentPlatform(), env: process.env })) {
    throw new Error('--user-data is inside an app data folder. Choose a folder outside it.');
  }
  if (existsSync(requested) && readdirSync(requested).length > 0) {
    throw new Error('--user-data must be a new or empty folder.');
  }
  mkdirSync(requested, { recursive: true });
  return { folder: requested, temporary: false };
}

/** Finds the Electron binary the app runs on, and the versions the report records. */
function buildInfo() {
  const requireFromDesktop = createRequire(join(DESKTOP, 'package.json'));
  const electronPath = requireFromDesktop('electron');
  if (!existsSync(electronPath)) throw new Error('The Electron binary is missing. Run "npm ci" in the repository.');
  if (!existsSync(join(DESKTOP, 'dist', 'main', 'index.js'))) {
    throw new Error('The app is not built. Run "npm run build" first.');
  }
  return {
    electronPath,
    electronVersion: requireFromDesktop('electron/package.json').version,
    appVersion: JSON.parse(readFileSync(join(DESKTOP, 'package.json'), 'utf8')).version,
  };
}

/** The app's environment: inherited settings, minus any COMPANYOS_ variable, plus the ones this run sets. */
function childEnvironment(folder, options) {
  const env = { ...process.env };
  for (const key of Object.keys(env)) if (key.startsWith('COMPANYOS_')) delete env[key];
  env.COMPANYOS_USER_DATA = folder;
  if (options.seedDays > 0) env.COMPANYOS_MEASURE_SEED_DAYS = String(options.seedDays);
  if (options.capture === 'fake') env.COMPANYOS_TEST_FAKE_PLATFORM = join(folder, 'front-app.txt');
  // Linux has no keyring on most dev machines. This lets the app start on synthetic data in this folder only.
  if (currentPlatform() === 'linux') env.COMPANYOS_TEST_BASIC_STORE = '1';
  return env;
}

function launch(electronPath, args, env) {
  const child = spawn(electronPath, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const remember = data => {
    for (const line of data.toString().split('\n')) {
      if (!line.trim()) continue;
      lines.push(line);
      if (lines.length > 40) lines.shift();
    }
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  const state = { exit: undefined, tail: () => lines.join('\n') };
  state.exited = new Promise(resolveExit => {
    const finish = result => {
      if (state.exit === undefined) state.exit = result;
      resolveExit(state.exit);
    };
    child.once('error', error => finish({ code: null, signal: null, error }));
    child.once('exit', (code, signal) => finish({ code, signal }));
  });
  return { child, state };
}

function describeExit(exit) {
  if (exit.error) return exit.error.message;
  return exit.signal ? `signal ${exit.signal}` : `exit code ${exit.code}`;
}

async function waitForStartup(folder, state) {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (!existsSync(join(folder, 'data-key.bin'))) {
    if (state.exit) throw new Error(`The app exited during startup (${describeExit(state.exit)}).\n${state.tail()}`);
    if (Date.now() > deadline) {
      throw new Error('The app did not finish starting within 60 seconds. A dialog may be waiting on screen.');
    }
    await sleep(250);
  }
}

function cpuBy(rows) {
  return new Map(rows.map(row => [row.pid, row.cpuSeconds]));
}

function round(value, digits) {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

/** One sample every interval, for the whole measured window. Each CPU figure covers the time since the last reading. */
async function sampleRun(state, rootPid, { duration, interval }) {
  const samples = [];
  let previous = cpuBy(descendantsOf(await readProcessTable(), rootPid));
  let mark = performance.now();
  const started = mark;
  for (let at = interval; at <= duration; at += interval) {
    await sleep(Math.max(0, started + at * 1000 - performance.now()));
    if (state.exit) throw new Error(`The app exited during the measurement (${describeExit(state.exit)}).\n${state.tail()}`);
    const tree = descendantsOf(await readProcessTable(), rootPid);
    const now = performance.now();
    const elapsed = (now - mark) / 1000;
    samples.push({
      t: at,
      cpuPercent: round(cpuPercent(previous, tree, elapsed), 2),
      rssMiB: round(sumRss(tree) / MIB, 1),
      processes: tree.length,
    });
    previous = cpuBy(tree);
    mark = now;
  }
  return samples;
}

/**
 * Closes the app the way a person would, then clears any helper that outlived it. Helpers are matched by pid and
 * command, so a pid that was reused in the meantime is left alone.
 */
async function stopApp(child, state, rootPid) {
  const before = descendantsOf(await readProcessTable().catch(() => []), rootPid);
  if (state.exit === undefined) {
    child.kill('SIGTERM');
    await Promise.race([state.exited, sleep(STOP_TIMEOUT_MS)]);
    if (state.exit === undefined) child.kill('SIGKILL');
    await state.exited;
  }
  await sleep(2000);
  const commands = new Map((await readProcessTable().catch(() => [])).map(row => [row.pid, row.command]));
  let leftovers = 0;
  for (const row of before) {
    if (row.pid === rootPid || commands.get(row.pid) !== row.command) continue;
    leftovers++;
    try {
      process.kill(row.pid, 'SIGKILL');
    } catch {
      // It exited on its own in the meantime.
    }
  }
  return leftovers;
}

function gitInfo() {
  const git = args =>
    new Promise(resolveGit => {
      execFile('git', args, { cwd: ROOT, timeout: 5000, windowsHide: true }, (error, stdout) =>
        resolveGit(error ? undefined : stdout.trim()),
      );
    });
  return Promise.all([git(['rev-parse', '--short', 'HEAD']), git(['status', '--porcelain'])]).then(([commit, status]) => ({
    commit: commit || 'unknown',
    dirty: Boolean(status),
  }));
}

function hostInfo() {
  const cores = cpus();
  return {
    platform: currentPlatform(),
    arch: arch(),
    osType: osType(),
    osRelease: release(),
    cpuModel: cores[0]?.model ?? 'unknown',
    cpuCount: cores.length,
    memoryMiB: Math.round(totalmem() / MIB),
    node: process.version,
  };
}

function notesFor(options, leftovers) {
  const notes = [
    'CPU is summed over the app\'s process tree and is a share of one core, so several busy cores can exceed 100%.',
    'RSS is the resident memory summed over the same processes, in MiB (1024 × 1024 bytes). Pages shared between processes, such as the Electron framework, are counted once per process, so the total is an upper bound.',
    `Startup is excluded. Sampling starts ${options.warmup} s after the data folder appears, and seeding finishes inside that time.`,
    `RSS is read every ${options.interval} s, so a spike shorter than that between samples is not seen.`,
  ];
  if (options.capture === 'fake') {
    notes.push('Capture used the test platform, which reads a file every 300 ms. The real macOS adapter polls every 3 s through osascript, so this run does not show that cost.');
  } else {
    notes.push('Capture used the platform adapter. On macOS the first run can ask for Automation permission for System Events. Until it is allowed, capture retries and its cost differs.');
  }
  if (options.duration < BUDGETS.gateSeconds) {
    notes.push(`The run covers ${options.duration} s. The release gate is a ${BUDGETS.gateSeconds / 60}-minute run.`);
  }
  if (leftovers > 0) notes.push(`${leftovers} helper process(es) outlived the app and were stopped by the harness.`);
  if (currentPlatform() === 'darwin') notes.push('macOS runs use Chromium\'s mock keychain for the data key, so the real Keychain is not touched. The data is synthetic and sits in this run\'s folder.');
  if (currentPlatform() === 'linux') notes.push('Linux runs set COMPANYOS_TEST_BASIC_STORE=1 so the app starts without a keyring. The data is synthetic and sits in this run\'s folder.');
  return notes;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(USAGE);
    return;
  }
  const { electronPath, electronVersion, appVersion } = buildInfo();
  const { folder, temporary } = prepareDataFolder(options.userData);
  if (options.capture === 'fake') writeFileSync(join(folder, 'front-app.txt'), 'Microsoft Excel');

  const args = [DESKTOP, `--user-data-dir=${folder}`];
  // Synthetic data only. The mock keychain stops the app's data key from touching the real Keychain, and so from
  // raising a Keychain prompt during a measurement. Its cost is negligible next to the budgets.
  if (currentPlatform() === 'darwin') args.push('--use-mock-keychain');
  if (currentPlatform() === 'linux') args.push('--password-store=basic');
  const { child, state } = launch(electronPath, args, childEnvironment(folder, options));
  const rootPid = child.pid;

  let shutdown;
  const stop = () => {
    shutdown ??= stopApp(child, state, rootPid);
    return shutdown;
  };
  process.once('SIGINT', () => void stop().finally(() => process.exit(130)));

  let samples;
  let leftovers = 0;
  try {
    await waitForStartup(folder, state);
    await sleep(options.warmup * 1000);
    if (state.exit) throw new Error(`The app exited during warm-up (${describeExit(state.exit)}).\n${state.tail()}`);
    samples = await sampleRun(state, rootPid, options);
  } finally {
    leftovers = await stop();
    if (temporary && !options.keepData) rmSync(folder, { recursive: true, force: true });
  }

  const summary = summarize(samples);
  const verdict = evaluate(summary, options.duration);
  const git = await gitInfo();
  const generatedAt = new Date().toISOString();
  const report = {
    schema: 'companyos-measure/1',
    generatedAt,
    host: hostInfo(),
    build: { commit: git.commit, dirty: git.dirty, appVersion, electronVersion },
    run: {
      durationSeconds: options.duration,
      intervalSeconds: options.interval,
      warmupSeconds: options.warmup,
      seedDays: options.seedDays,
      capture: options.capture,
      dataFolder: temporary ? 'temporary, removed after the run' : options.userData,
    },
    status: verdict.status,
    checks: verdict.checks,
    summary,
    samples,
    notes: notesFor(options, leftovers),
  };

  mkdirSync(options.out, { recursive: true });
  const stamp = generatedAt.replace(/[:.]/g, '-');
  const jsonPath = join(options.out, `measure-${stamp}.json`);
  const markdownPath = join(options.out, `measure-${stamp}.md`);
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  writeFileSync(markdownPath, toMarkdown(report));
  process.stdout.write(
    [
      `${verdict.status === 'gate' ? 'Gate run' : 'Indicative run only (shorter than the 30-minute gate)'}: ${samples.length} samples.`,
      `Average CPU ${summary.cpuPercent.mean.toFixed(2)}% (budget under ${BUDGETS.cpuAveragePercent}%).`,
      `RSS average ${summary.rssMiB.mean.toFixed(1)} MiB, highest ${summary.rssMiB.max.toFixed(1)} MiB (budget under ${BUDGETS.rssMiB} MiB).`,
      `JSON: ${jsonPath}`,
      `Markdown: ${markdownPath}`,
      '',
    ].join('\n'),
  );
}

// Run only when executed directly, so the tests can import the pure helpers.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => {
    process.stderr.write(`measure: ${error.message}\n`);
    process.exitCode = 1;
  });
}
