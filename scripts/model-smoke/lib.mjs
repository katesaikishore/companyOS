// Shared helpers for the opt-in real-model checks. Nothing here runs by itself and nothing here is part of the app.
// It needs the engine built first: npm run build -w @companyos/twin-core
import { fork } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { arch, cpus, homedir, platform, release, tmpdir, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The engine's compiled output. The catalogue, the downloader and the verifier come from here, not from a copy. */
export const core = require('@companyos/twin-core');

/** Where the models are kept. Outside the repository. COMPANYOS_MODEL_CACHE overrides it. */
export function cacheDir() {
  return process.env.COMPANYOS_MODEL_CACHE ?? join(homedir(), '.cache', 'companyos-model-smoke');
}

const GIB = 1024 ** 3;

/**
 * Makes sure a catalogue model is in the cache, with the size and SHA-256 the catalogue pins. A file that already
 * verifies is kept. Anything else is downloaded with the app's own downloader (host allowlist, https only, size and
 * digest checked before the file is kept).
 */
export async function ensureModel(id, log = console.error) {
  const spec = core.findModel(id);
  if (!spec) throw new Error(`The catalogue has no model called ${id}.`);
  const dir = cacheDir();
  const path = join(dir, spec.file);
  const started = performance.now();
  if (await core.verifyModelFile(path, spec)) {
    log(`${spec.file}: already in the cache and the SHA-256 matches (${spec.sha256.slice(0, 12)}...)`);
    return { spec, path, dir, downloaded: false, seconds: 0 };
  }
  log(`${spec.file}: downloading ${(spec.sizeBytes / GIB).toFixed(2)} GiB from huggingface.co/${spec.repo}`);
  let lastLogged = 0;
  const result = await core.downloadModel({
    spec,
    destinationDir: dir,
    allowedHosts: core.HUGGING_FACE_HOSTS,
    onProgress: (received, total) => {
      const percent = Math.floor((received / total) * 10) * 10;
      if (percent > lastLogged) {
        lastLogged = percent;
        log(`  ${percent}%`);
      }
    },
  });
  const seconds = (performance.now() - started) / 1000;
  log(`${spec.file}: ${result.bytes} bytes, SHA-256 ${result.sha256} (matches the catalogue), ${seconds.toFixed(1)} s`);
  log(`  hosts contacted: ${result.hosts.join(' -> ')}`);
  return { spec, path, dir, downloaded: true, seconds };
}

/**
 * Linux only. Resident memory of a process in MiB: the total, the part that is private (anonymous), the part that is
 * file-backed (a memory-mapped model file counts here), and the peak total since the process started.
 */
export function memoryOf(pid) {
  try {
    const text = readFileSync(`/proc/${pid}/status`, 'utf8');
    const mib = name => Number(new RegExp(`^${name}:\\s+(\\d+) kB`, 'm').exec(text)?.[1] ?? NaN) / 1024;
    return { rssMiB: mib('VmRSS'), anonMiB: mib('RssAnon'), fileMiB: mib('RssFile'), peakRssMiB: mib('VmHWM') };
  } catch {
    return { rssMiB: NaN, anonMiB: NaN, fileMiB: NaN, peakRssMiB: NaN };
  }
}

export function machine() {
  const cpu = cpus();
  return {
    platform: `${platform()} ${release()}`,
    arch: arch(),
    cpuModel: cpu[0]?.model ?? 'unknown',
    cpuThreads: cpu.length,
    memoryGiB: Number((totalmem() / GIB).toFixed(1)),
    node: process.version,
  };
}

export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let index = 0; index < a.length; index++) {
    dot += a[index] * b[index];
    normA += a[index] * a[index];
    normB += b[index] * b[index];
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export const round = (value, places = 2) => Number(value.toFixed(places));

/**
 * Starts the app's compiled model worker in a Node child process (see worker-shim.cjs) and wraps it as the
 * WorkerChannel the engine's LocalModelClient expects. Needs: npm run build -w @companyos/desktop
 */
export function startRealWorker() {
  const workerFile = join(repoRoot, 'apps', 'desktop', 'dist', 'main', 'llm-worker.js');
  if (!existsSync(workerFile)) throw new Error('Build the desktop app first: npm run build -w @companyos/desktop');
  // Like the app, the worker's output is not kept. The stderr pipe is only read when the worker exits unexpectedly.
  const child = fork(join(repoRoot, 'scripts', 'model-smoke', 'worker-shim.cjs'), [], {
    stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  child.stderr.resume();
  const channel = {
    post: message => child.send(message),
    onMessage: listener => child.on('message', listener),
    onExit: listener => {
      child.once('exit', listener);
    },
    kill: () => {
      child.kill();
    },
  };
  return { channel, child };
}

/**
 * Three routines mined from seeded working days by the real engine (TwinAgent), in a throw-away data folder with a
 * random key. Each day has three work blocks, split by idle gaps. Only app names are written, as in the app.
 */
export function seededRoutines(days = 8) {
  const dir = mkdtempSync(join(tmpdir(), 'model-smoke-'));
  const at = (day, hour, minute = 0) => new Date(2026, 9, 1 + day, hour, minute).getTime();
  const blocks = [
    { hour: 9, apps: ['Microsoft Excel', 'Microsoft Outlook', 'Slack'] },
    { hour: 11, apps: ['Visual Studio Code', 'Google Chrome', 'Microsoft Teams'] },
    { hour: 14, apps: ['Zoom', 'Notion', 'Microsoft Outlook'] },
  ];
  const agent = new core.TwinAgent({ dataDir: dir, dataKey: randomBytes(32), now: () => at(days, 0) });
  agent.updateConfig({ watchBrowsers: true });
  for (let day = 0; day < days; day++) {
    for (const block of blocks) {
      block.apps.forEach((app, index) => {
        const url = app === 'Google Chrome' ? { url: 'https://github.com/pulls' } : {};
        agent.ingest({ kind: 'focus', ts: at(day, block.hour, index * 10), app, ...url });
      });
      agent.ingest({ kind: 'idle_start', ts: at(day, block.hour, 45) });
    }
  }
  return { agent, dir, routines: agent.routinesToName() };
}

/**
 * Routines made up from app names with a fixed random seed, so a run can be repeated. They are not mined from activity.
 * Used to see how a model behaves over many different inputs, not for anything the app does.
 */
export function syntheticRoutines(count = 60, seed = 12345) {
  const apps = [
    'microsoft excel', 'microsoft outlook', 'slack', 'visual studio code', 'google chrome', 'microsoft teams', 'zoom',
    'notion', 'microsoft word', 'figma', 'firefox', 'thunderbird', 'libreoffice calc', 'discord', 'obsidian', 'pycharm',
    'xcode', 'safari', 'numbers', 'pages', 'whatsapp', 'telegram',
  ];
  let state = seed;
  const next = () => (state = (state * 1664525 + 1013904223) % 2 ** 32) / 2 ** 32;
  const pick = () => apps[Math.floor(next() * apps.length)];
  return Array.from({ length: count }, (_, index) => {
    const length = 3 + Math.floor(next() * 4);
    const steps = Array.from({ length }, () => {
      const app = pick();
      const other = pick();
      return { windowClass: 'other', app, options: next() < 0.3 ? [app, other] : [app] };
    });
    return {
      id: `synthetic-${index}`,
      steps,
      support: 3 + Math.floor(next() * 30),
      days: 3 + Math.floor(next() * 10),
      score: 0.5,
      segmentIds: [],
      durationMs: 1000,
      occurrencesPerWeek: Number((next() * 10).toFixed(2)),
      lastSeenAt: 0,
    };
  });
}

/**
 * The widest routine the engine can produce: six steps with five observed apps each, every app name 130 characters of
 * plain letters (a capture adapter may send up to 200). Before app names were cut for the prompt (MAX_APP_NAME_CHARS),
 * its prompt was 4,169 characters, over the 4,000 the worker accepts, so the worker refused it as if the model had failed.
 */
export function widestRoutine() {
  const steps = Array.from({ length: 6 }, (_, step) => {
    const options = Array.from({ length: 5 }, (_, option) => `Work App ${step * 5 + option} `.padEnd(130, 'x'));
    return { windowClass: 'other', app: options[0], options };
  });
  return { id: 'widest', steps, support: 5, days: 5, score: 0.5, segmentIds: [], durationMs: 1, occurrencesPerWeek: 3, lastSeenAt: 0 };
}

/** True while a process with this id exists (a stopped child that has not been reaped yet still counts). */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Waits until a process is gone, up to timeoutMs, and returns whether it is. A stopped worker does not vanish at once:
 * it finishes the step it is computing and frees the model first, which took between 50 and 300 ms here.
 */
export async function waitUntilGone(pid, timeoutMs = 5_000) {
  const deadline = performance.now() + timeoutMs;
  while (isAlive(pid) && performance.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25));
  return !isAlive(pid);
}
