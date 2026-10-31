#!/usr/bin/env node
// Runs the agent-desktop 1.0.2 CLI (installed with npm i -g agent-desktop@1.0.2) against a real GUI app on a hosted
// runner. Records the JSON it prints, its exit status and how long each call took. Never asserts success.
// Harmless by design: the only key sent is a select-all chord to the test app (TextEdit or Notepad).
import { existsSync, readFileSync } from 'node:fs';
import { arch } from 'node:os';
import { join } from 'node:path';
import {
  IS_MAC,
  IS_WIN,
  OUT_DIR,
  bringOtherForward,
  capture,
  frontmostDirect,
  fileSize,
  launchOtherApp,
  launchTestApp,
  MARKER,
  ps,
  readClipboard,
  runMeta,
  screenshot,
  setClipboard,
  sha256File,
  sleep,
  stats,
  stopApps,
  truncate,
  writeJson,
} from './lib.mjs';

const CHORD = IS_MAC ? 'cmd+a' : 'ctrl+a';
const COPY_CHORD = IS_MAC ? 'cmd+c' : 'ctrl+c';
const report = { kind: 'agent-desktop', meta: runMeta(), version: '1.0.2', calls: [] };

function log(label, value) {
  console.log(`${label} ${JSON.stringify(value)}`);
}

async function globalRoot() {
  if (process.env.AGENT_DESKTOP_ROOT) return process.env.AGENT_DESKTOP_ROOT.trim();
  const result = await capture('npm', ['root', '-g'], { shell: true });
  return result.stdout.trim();
}

/** The native program inside the npm package, the way the package's own launcher picks it. */
function nativeBinary(packageDir) {
  const bin = join(packageDir, 'bin');
  const name = IS_WIN ? `agent-desktop-win32-${arch()}.exe` : `agent-desktop-${process.platform}-${arch()}`;
  const candidates = [join(bin, name), join(bin, IS_WIN ? 'agent-desktop.exe' : 'agent-desktop')];
  return candidates.find(path => existsSync(path));
}

async function provenance(binary, packageDir) {
  const info = { binary, bytes: fileSize(binary) };
  if (!binary) return info;
  info.sha256 = sha256File(binary);
  const sidecar = `${binary}.sha256`;
  try {
    info.sidecar = readFileSync(sidecar, 'utf8').trim();
    info.sidecarMatches = info.sidecar === info.sha256;
  } catch (error) {
    info.sidecarError = String(error.message);
  }
  if (IS_MAC) {
    info.codesign = await capture('codesign', ['-dvv', binary]);
    info.codesignVerify = await capture('codesign', ['--verify', '--strict', '--verbose=2', binary]);
    info.spctl = await capture('spctl', ['--assess', '--type', 'execute', '--verbose=2', binary]);
    info.quarantine = await capture('xattr', ['-l', binary]);
    info.file = await capture('file', [binary]);
  } else if (IS_WIN) {
    info.authenticode = await ps(
      '$s = Get-AuthenticodeSignature -FilePath $env:TWIN_FILE; [ordered]@{ status = $s.Status.ToString(); statusMessage = $s.StatusMessage; signer = $s.SignerCertificate.Subject; issuer = $s.SignerCertificate.Issuer } | ConvertTo-Json -Compress',
      { TWIN_FILE: binary },
      { timeoutMs: 60_000 },
    );
  }
  info.packageDir = packageDir;
  return info;
}

function parseEnvelope(text) {
  try {
    const value = JSON.parse(text);
    return {
      ok: value?.ok,
      errorCode: value?.error?.code ?? value?.code,
      errorMessage: value?.error?.message ?? value?.message,
      windowCount: Array.isArray(value?.data) ? value.data.length : undefined,
    };
  } catch {
    return undefined;
  }
}

/** One command, run `times` times. The first run keeps its output; the rest keep status and timing only. */
async function timed(label, binary, args, times, env, around = {}) {
  const runs = [];
  for (let index = 0; index < times; index++) {
    const before = around.before ? await around.before(index) : undefined;
    const result = await capture(binary, args, { env, timeoutMs: 30_000, outputLimit: index === 0 ? 6000 : 600 });
    const after = around.after ? await around.after(index) : undefined;
    const envelope = parseEnvelope(result.stdout);
    runs.push({
      frontBefore: before,
      frontAfter: after,
      exitCode: result.exitCode,
      signal: result.signal,
      timedOut: result.timedOut,
      durationMs: result.durationMs,
      envelope,
      stdout: index === 0 ? result.stdout : undefined,
      stderr: result.stderr || undefined,
      errorMessage: result.errorMessage,
    });
  }
  const entry = {
    label,
    command: `agent-desktop ${args.join(' ')}`,
    runs,
    timing: stats(runs.map(run => run.durationMs)),
    exitCodes: runs.map(run => run.exitCode),
  };
  report.calls.push(entry);
  log('CALL', { ...entry, runs: entry.runs.map(run => ({ ...run, stdout: truncate(run.stdout ?? '', 400) })) });
  return entry;
}

let app;
let other;
try {
  const packageDir = join(await globalRoot(), 'agent-desktop');
  const binary = nativeBinary(packageDir);
  report.binary = await provenance(binary, packageDir);
  log('BINARY', report.binary);
  if (!binary) throw new Error(`no native agent-desktop binary found under ${packageDir}`);

  const env = { ...process.env };
  const helper = join(packageDir, 'bin', `agent-desktop-macos-helper-${process.platform}-${arch()}`);
  if (IS_MAC && existsSync(helper)) env.AGENT_DESKTOP_MACOS_HELPER_PATH = helper;
  report.helperPath = IS_MAC ? (existsSync(helper) ? helper : null) : undefined;

  report.version_output = await capture(binary, ['--version'], { env });
  log('VERSION', report.version_output);

  const launched = await launchTestApp();
  app = launched.app;
  report.testApp = launched;
  log('TESTAPP', launched);
  report.screenshots = [await screenshot('after-launch')];

  other = await launchOtherApp();
  report.otherApp = other;

  // Which name does the CLI know the app by? On Windows, list-apps shows names with .exe. A name that matches nothing
  // still exits 0 with an empty list, so every candidate is tried and the first that lists a window is used.
  const names = IS_MAC ? ['TextEdit'] : ['notepad.exe', 'Notepad', 'notepad'];
  let appName;
  report.nameProbe = [];
  for (const candidate of names) {
    const probe = await capture(binary, ['list-windows', '--app', candidate], { env, timeoutMs: 30_000 });
    const envelope = parseEnvelope(probe.stdout);
    report.nameProbe.push({ candidate, exitCode: probe.exitCode, envelope, stdout: truncate(probe.stdout, 800), stderr: probe.stderr });
    if (!appName && probe.exitCode === 0 && (envelope?.windowCount ?? 0) > 0) appName = candidate;
  }
  appName ??= names[0];
  report.appName = appName;

  await timed('status', binary, ['status'], 5, env);
  await timed('list-apps', binary, ['list-apps'], 5, env);
  await timed('list-windows', binary, ['list-windows', '--app', appName], 5, env);

  // Focus: put the other app in front first, so a focus has something to change. Record who was in front before and after.
  await timed('focus-window', binary, ['focus-window', '--app', appName], 3, env, {
    before: async () => {
      await bringOtherForward(other?.app);
      await sleep(700);
      return (await frontmostDirect()).stdout.trim();
    },
    after: async () => {
      await sleep(300);
      return (await frontmostDirect()).stdout.trim();
    },
  });

  // Press: always after a focus-window call, as the product's executor does. Keep who was in front afterwards.
  const press = [];
  for (let index = 0; index < 3; index++) {
    await bringOtherForward(other?.app);
    await sleep(700);
    const focusCall = await capture(binary, ['focus-window', '--app', appName], { env, timeoutMs: 30_000 });
    const pressCall = await capture(binary, ['press', CHORD, '--app', appName], { env, timeoutMs: 30_000, outputLimit: 3000 });
    const front = (await frontmostDirect()).stdout.trim();
    press.push({
      focusExit: focusCall.exitCode,
      focusMs: focusCall.durationMs,
      pressExit: pressCall.exitCode,
      pressMs: pressCall.durationMs,
      pressEnvelope: parseEnvelope(pressCall.stdout),
      pressStdout: index === 0 ? pressCall.stdout : undefined,
      pressStderr: pressCall.stderr || undefined,
      frontAfterPress: front,
    });
  }
  report.pressAfterFocus = {
    command: `agent-desktop press ${CHORD} --app ${appName}`,
    runs: press,
    timing: stats(press.map(run => run.pressMs)),
  };
  log('PRESS_AFTER_FOCUS', report.pressAfterFocus);

  // Press with the other app in front and no focus call, to see what the CLI does with a window that is not in front.
  await bringOtherForward(other?.app);
  await sleep(700);
  const frontBefore = (await frontmostDirect()).stdout.trim();
  const cold = await capture(binary, ['press', CHORD, '--app', appName], { env, timeoutMs: 30_000, outputLimit: 3000 });
  report.pressWithoutFocus = {
    frontBefore,
    exitCode: cold.exitCode,
    durationMs: cold.durationMs,
    envelope: parseEnvelope(cold.stdout),
    stdout: cold.stdout,
    stderr: cold.stderr,
    frontAfter: (await frontmostDirect()).stdout.trim(),
  };
  log('PRESS_WITHOUT_FOCUS', report.pressWithoutFocus);

  // Did the keys reach the app? Put a sentinel on the clipboard, select all, copy, read the clipboard back. Once after a
  // focus-window call, and once with the other app in front and no focus call.
  report.deliveryChecks = [];
  for (const withFocus of [true, false]) {
    await setClipboard('twin-smoke-sentinel');
    await bringOtherForward(other?.app);
    await sleep(700);
    const frontBefore = (await frontmostDirect()).stdout.trim();
    const calls = [];
    const call = async args => {
      const result = await capture(binary, args, { env, timeoutMs: 30_000, outputLimit: 1500 });
      calls.push({ args: args.join(' '), exitCode: result.exitCode, durationMs: result.durationMs, envelope: parseEnvelope(result.stdout), stderr: result.stderr || undefined });
    };
    if (withFocus) await call(['focus-window', '--app', appName]);
    await call(['press', CHORD, '--app', appName]);
    await call(['press', COPY_CHORD, '--app', appName]);
    await sleep(300);
    const clip = await readClipboard();
    const entry = {
      withFocusCall: withFocus,
      frontBefore,
      calls,
      frontAfter: (await frontmostDirect()).stdout.trim(),
      clipboard: truncate(clip.stdout, 120),
      equalsMarker: clip.stdout.trim() === MARKER,
    };
    report.deliveryChecks.push(entry);
    log('DELIVERY', entry);
  }

  // An app that is not running.
  await timed('focus-window (app not running)', binary, ['focus-window', '--app', 'TwinNoSuchApp'], 3, env);
  report.screenshots.push(await screenshot('after-press'));
} catch (error) {
  report.fatal = { name: error?.name, message: truncate(error?.message ?? error, 1500) };
  log('FATAL', report.fatal);
} finally {
  try {
    report.cleanup = await stopApps([app, other?.app].filter(Boolean));
  } catch (error) {
    report.cleanup = { error: truncate(error?.message ?? error, 600) };
  }
  report.finishedAt = new Date().toISOString();
  report.outDir = OUT_DIR;
  writeJson(`agent-desktop-${process.platform}.json`, report);
  console.log(`WROTE agent-desktop-${process.platform}.json (${report.calls.length} timed commands)`);
  process.exit(0);
}
