#!/usr/bin/env node
// Runs the real macOS or Windows adapter from apps/desktop/src/main/platform.ts (built to dist) against a real GUI app and
// records what happens as JSON. It never asserts success. The adapter turns every failure into `false` and drops the
// error text, so this script also wraps child_process.execFile to keep each command line, exit code and stderr the
// adapter produced. That is the only way to see why a call returned false.
import cp from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  MARKER,
  OUT_DIR,
  bringOtherForward,
  launchOtherApp,
  launchTestApp,
  cleanStderr,
  readClipboard,
  round,
  runMeta,
  screenshot,
  setClipboard,
  shortArg,
  sleep,
  stopApps,
  systemInfo,
  truncate,
  writeJson,
} from './lib.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const platformJs = resolve(root, 'apps/desktop/dist/main/platform.js');
const SELECT_ALL = 'cmd+a'; // control+a on Windows, command+a on macOS. Selects text, changes nothing.
const COPY = 'cmd+c'; // used only to prove that a key reached the app, by reading the clipboard

// Wrap execFile before the adapter module is loaded. The adapter looks the function up at call time.
const observed = [];
const realExecFile = cp.execFile;
cp.execFile = function observedExecFile(file, ...rest) {
  const args = Array.isArray(rest[0]) ? rest[0] : [];
  const options = rest.find(item => item && typeof item === 'object' && !Array.isArray(item)) ?? {};
  const entry = {
    command: [file, ...args.map(shortArg)].join(' '),
    twinEnv: Object.fromEntries(Object.entries(options.env ?? {}).filter(([key]) => key.startsWith('TWIN_'))),
    timeoutMs: options.timeout,
  };
  const started = performance.now();
  observed.push(entry);
  const callbackIndex = rest.findIndex(item => typeof item === 'function');
  if (callbackIndex >= 0) {
    const original = rest[callbackIndex];
    rest[callbackIndex] = (error, stdout, stderr) => {
      Object.assign(entry, {
        exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        errorCode: error && typeof error.code !== 'number' ? String(error.code) : undefined,
        signal: error?.signal ?? null,
        timedOut: error?.killed === true,
        stdout: truncate(stdout ?? '', 1500),
        stderr: truncate(cleanStderr(stderr ?? ''), 1500),
        durationMs: round(performance.now() - started),
      });
      original(error, stdout, stderr);
    };
  }
  return realExecFile.call(this, file, ...rest);
};

const report = { kind: 'adapter-smoke', meta: runMeta(), steps: [], screenshots: [] };

async function step(name, work, withFront) {
  const first = observed.length;
  const started = performance.now();
  const entry = { name };
  try {
    entry.result = await work();
  } catch (error) {
    entry.error = { name: error?.name, code: error?.code, message: truncate(error?.message ?? error, 1500) };
  }
  entry.durationMs = round(performance.now() - started);
  if (withFront) {
    try {
      entry.frontmostAfter = (await withFront()) ?? null;
    } catch (error) {
      entry.frontmostAfterError = truncate(error?.message ?? error, 600);
    }
  }
  entry.subprocesses = observed.slice(first).map(item => ({ ...item }));
  report.steps.push(entry);
  console.log(`STEP ${JSON.stringify(entry)}`);
  return entry;
}

async function shot(label) {
  try {
    const result = await screenshot(label);
    report.screenshots.push(result);
    console.log(`SHOT ${JSON.stringify(result)}`);
  } catch (error) {
    report.screenshots.push({ label, error: truncate(error?.message ?? error, 600) });
  }
}

let app;
let other;
try {
  report.system = await systemInfo();
  console.log(`SYSTEM ${JSON.stringify(report.system)}`);

  const module = await import(pathToFileURL(platformJs).href);
  const { choosePlatform, executorFor } = { ...module, ...(module.default ?? {}) };
  let platform;
  await step('choosePlatform', async () => {
    const choice = await choosePlatform();
    platform = choice.platform;
    return {
      detail: choice.detail,
      adapter: platform?.name,
      pollMs: platform?.pollMs,
      has: Object.fromEntries(['openUrl', 'openFile', 'pressShortcut'].map(key => [key, typeof platform?.[key] === 'function'])),
    };
  });
  if (!platform) throw new Error('choosePlatform returned no adapter');
  const executor = executorFor(platform);
  await step('executorFor', async () => Object.keys(executor));
  const front = () => executor.frontmostApp();

  await step('frontmost before launch', front);

  const launched = await launchTestApp();
  app = launched.app;
  await step('launch test app', async () => launched);
  await shot('after-launch');
  const name = app;
  const isFront = entry => (entry.frontmostAfter ?? '').toLowerCase() === name.toLowerCase();
  const withApp = () => front();

  await step('frontmost after launch', front);

  other = await launchOtherApp();
  await step('other app for focus changes', async () => other);
  const otherName = other.app;

  // 1. Press with another app in front. The adapter has to bring the app forward by itself.
  if (otherName) {
    await step(`focus other app (${otherName})`, () => executor.focusApp(otherName), withApp);
    await bringOtherForward(otherName);
    await sleep(500);
  }
  await step('frontmost before press from other app', front);
  const press1 = await step(`pressShortcut ${SELECT_ALL} while other app in front`, () => executor.pressShortcut?.(name, SELECT_ALL), withApp);
  report.pressFromOtherAppLeftAppInFront = isFront(press1);

  // 2. Focus three times, each time after another app was in front. Timing and whether the app ended up in front.
  for (let index = 1; index <= 3; index++) {
    if (otherName) {
      await bringOtherForward(otherName);
      await sleep(700);
    }
    await step(`frontmost before focus #${index}`, front);
    await step(`focus ${name} #${index}`, () => executor.focusApp(name), withApp);
  }

  // 3. Press with the app already in front, three times for timing.
  for (let index = 1; index <= 3; index++) {
    await step(`pressShortcut ${SELECT_ALL} #${index}`, () => executor.pressShortcut?.(name, SELECT_ALL), withApp);
  }

  // 4. Did a key reach the app? Put a sentinel on the clipboard, select all, copy, read the clipboard back.
  await step('clipboard sentinel set', () => setClipboard('twin-smoke-sentinel'));
  await step(`pressShortcut ${SELECT_ALL} (delivery check)`, () => executor.pressShortcut?.(name, SELECT_ALL), withApp);
  await step(`pressShortcut ${COPY} (delivery check)`, () => executor.pressShortcut?.(name, COPY), withApp);
  const clip = await step('clipboard read after copy', async () => {
    const read = await readClipboard();
    return { text: truncate(read.stdout, 200), equalsMarker: read.stdout.trim() === MARKER, exitCode: read.exitCode, stderr: read.stderr };
  });
  report.keyReachedApp = clip.result?.equalsMarker ?? false;
  await shot('after-press');

  // 5. Negative controls. Both should be false.
  await step('focus app that is not running', () => executor.focusApp('TwinNoSuchApp'));
  await step('pressShortcut to app that is not running', () => executor.pressShortcut?.('TwinNoSuchApp', SELECT_ALL));
  await step('pressShortcut with a chord outside the grammar', () => executor.pressShortcut?.(name, 'cmd+notakey'));

  // 6. Frontmost timing.
  for (let index = 1; index <= 3; index++) await step(`frontmost #${index}`, front);

  // 7. openFile: opens the marker file again in the app, through the adapter's own launch command. Last, because it can
  // add a second window.
  await step(`openFile ${name} (adapter launch command)`, () => executor.openFile?.(name, launched.file), withApp);
} catch (error) {
  report.fatal = { name: error?.name, message: truncate(error?.message ?? error, 1500) };
  console.log(`FATAL ${JSON.stringify(report.fatal)}`);
} finally {
  await shot('end');
  try {
    report.cleanup = await stopApps([app, other?.app].filter(Boolean));
  } catch (error) {
    report.cleanup = { error: truncate(error?.message ?? error, 600) };
  }
  report.finishedAt = new Date().toISOString();
  report.outDir = OUT_DIR;
  writeJson(`adapter-smoke-${process.platform}.json`, report);
  console.log(`WROTE adapter-smoke-${process.platform}.json (${report.steps.length} steps)`);
  // Exit 0 on purpose. A failed call is data. Only a crash of this script would show as a failed step above.
  process.exit(0);
}
