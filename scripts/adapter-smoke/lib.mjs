// Shared helpers for the adapter smoke scripts. Nothing here asserts success: every call returns a record of what
// happened (exit code, signal, output, error text, time) and the scripts write those records out as JSON.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { arch, release, tmpdir } from 'node:os';
import { join } from 'node:path';

// Captured at import time. smoke.mjs wraps child_process.execFile afterwards to observe the adapter, and these
// helpers must not show up in that log.
const realExecFile = execFile;

export const IS_MAC = process.platform === 'darwin';
export const IS_WIN = process.platform === 'win32';
export const MARKER = 'twin-smoke-marker-7f3a';
export const OUT_DIR = process.env.ADAPTER_SMOKE_OUT || join(process.cwd(), 'adapter-smoke-out');

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
export const round = value => Math.round(value * 10) / 10;

export function truncate(text, limit = 3000) {
  const value = typeof text === 'string' ? text : String(text ?? '');
  return value.length > limit ? `${value.slice(0, limit)}...[${value.length - limit} more characters]` : value;
}

/** Long arguments (an inline script, an encoded command) are shortened so the log stays readable. */
export function shortArg(arg) {
  const value = String(arg);
  return value.length > 160 ? `${value.slice(0, 60).replace(/\s+/g, ' ')}...<${value.length} characters>` : value;
}

export function ensureOut() {
  mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

export function writeJson(name, data) {
  ensureOut();
  writeFileSync(join(OUT_DIR, name), `${JSON.stringify(data, null, 2)}\n`);
}

/** Runs a program and always resolves with a record. It never throws and never treats a failure as special. */
export function capture(file, args = [], options = {}) {
  const { env, timeoutMs = 20_000, input, shell = false } = options;
  const started = process.hrtime.bigint();
  const command = [file, ...args.map(shortArg)].join(' ');
  return new Promise(resolve => {
    const finish = (error, stdout, stderr) =>
      resolve({
        command,
        exitCode: error ? (typeof error.code === 'number' ? error.code : null) : 0,
        errorCode: error && typeof error.code !== 'number' ? String(error.code) : undefined,
        signal: error?.signal ?? null,
        timedOut: error?.killed === true,
        stdout: truncate(stdout ?? '', options.outputLimit ?? 3000),
        stderr: truncate(stderr ?? '', options.outputLimit ?? 3000),
        errorMessage: error ? truncate(error.message, 600) : undefined,
        durationMs: round(Number(process.hrtime.bigint() - started) / 1e6),
      });
    try {
      const child = realExecFile(
        file,
        args,
        { timeout: timeoutMs, windowsHide: true, env: env ?? process.env, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', shell },
        finish,
      );
      if (input !== undefined && child.stdin) {
        child.stdin.on('error', () => {});
        child.stdin.end(input);
      }
    } catch (error) {
      finish(error, '', '');
    }
  });
}

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

/** Runs a PowerShell script text as an encoded command, the same way the adapter does. Values go in through the environment. */
export function ps(script, extraEnv = {}, options = {}) {
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  return capture('powershell.exe', [...POWERSHELL, encoded], { ...options, env: { ...process.env, ...extraEnv } });
}

export function stats(durations) {
  if (!durations.length) return undefined;
  const sorted = [...durations].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return { n: sorted.length, minMs: sorted[0], medianMs: round(median), maxMs: sorted[sorted.length - 1] };
}

export function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function fileSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return undefined;
  }
}

export function runMeta() {
  const env = process.env;
  return {
    startedAt: new Date().toISOString(),
    node: process.version,
    platform: process.platform,
    arch: arch(),
    osRelease: release(),
    runnerOs: env.RUNNER_OS,
    runnerArch: env.RUNNER_ARCH,
    runnerName: env.RUNNER_NAME,
    imageOs: env.ImageOS,
    imageVersion: env.ImageVersion,
    runId: env.GITHUB_RUN_ID,
    sha: env.GITHUB_SHA,
  };
}

const WIN_INFO = `
$ErrorActionPreference = 'Continue'
$info = [ordered]@{}
$info.psVersion = $PSVersionTable.PSVersion.ToString()
$info.os = (Get-CimInstance Win32_OperatingSystem).Caption
$info.osVersion = [Environment]::OSVersion.Version.ToString()
$info.user = [Environment]::UserName
$info.userInteractive = [Environment]::UserInteractive
$info.sessionName = $env:SESSIONNAME
$info.sessionId = (Get-Process -Id $PID).SessionId
$info.elevated = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
Add-Type -AssemblyName System.Windows.Forms
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$info.virtualScreen = "$($screen.Width)x$($screen.Height)"
Add-Type -Namespace Twin -Name Diag -MemberDefinition '[DllImport("user32.dll")] public static extern System.IntPtr GetForegroundWindow();'
$info.foregroundWindowHandle = [Twin.Diag]::GetForegroundWindow().ToInt64()
$info | ConvertTo-Json -Compress
`;

const MAC_TCC_QUERY =
  "select service, client, auth_value, auth_reason from access where service in ('kTCCServiceAccessibility','kTCCServiceAppleEvents','kTCCServicePostEvent','kTCCServiceListenEvent','kTCCServiceScreenCapture')";

/** Facts about the machine and its desktop session. Failures are kept as records. */
export async function systemInfo() {
  const checks = {};
  if (IS_MAC) {
    checks.swVers = await capture('sw_vers');
    checks.whoami = await capture('whoami');
    checks.launchctlManager = await capture('launchctl', ['managername']);
    checks.windowServer = await capture('pgrep', ['-lx', 'WindowServer']);
    checks.finder = await capture('pgrep', ['-lx', 'Finder']);
    checks.consoleUser = await capture('stat', ['-f', '%Su', '/dev/console']);
    checks.systemTcc = await capture('sqlite3', ['-readonly', '/Library/Application Support/com.apple.TCC/TCC.db', MAC_TCC_QUERY]);
    checks.userTcc = await capture('sqlite3', [
      '-readonly',
      join(process.env.HOME ?? '', 'Library/Application Support/com.apple.TCC/TCC.db'),
      MAC_TCC_QUERY,
    ]);
    checks.systemEventsCount = await capture('osascript', ['-e', 'tell application "System Events" to count processes'], { timeoutMs: 15_000 });
  } else if (IS_WIN) {
    checks.desktopInfo = await ps(WIN_INFO, {}, { timeoutMs: 30_000 });
    checks.querySession = await capture('query', ['session']);
  }
  return checks;
}

/** Best-effort screenshot of the whole desktop into the output folder. A failure is recorded, not thrown. */
export async function screenshot(label) {
  ensureOut();
  const file = join(OUT_DIR, `screenshot-${process.platform}-${label}.png`);
  const record = IS_MAC
    ? await capture('screencapture', ['-x', file])
    : IS_WIN
      ? await ps(
          `
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
$screen = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bitmap = New-Object System.Drawing.Bitmap $screen.Width, $screen.Height
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
$graphics.CopyFromScreen($screen.Location, [System.Drawing.Point]::Empty, $screen.Size)
$bitmap.Save($env:TWIN_SHOT, [System.Drawing.Imaging.ImageFormat]::Png)
'saved'
`,
          { TWIN_SHOT: file },
          { timeoutMs: 30_000 },
        )
      : undefined;
  return { label, file: fileSize(file) ? file : undefined, bytes: fileSize(file), record };
}

/** Frontmost application by direct OS call, independent of the adapter under test. */
export async function frontmostDirect() {
  if (IS_MAC) {
    return capture('osascript', ['-e', 'tell application "System Events" to get name of first process whose frontmost is true'], { timeoutMs: 15_000 });
  }
  return ps(
    `
Add-Type -Namespace Twin -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
$processId = [uint32]0
[void][Twin.Fg]::GetWindowThreadProcessId([Twin.Fg]::GetForegroundWindow(), [ref]$processId)
(Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName
`,
    {},
    { timeoutMs: 30_000 },
  );
}

/** Starts the test app on a temp file that holds a known marker line. Waits for its process and a window. */
export async function launchTestApp() {
  const dir = mkdtempSync(join(tmpdir(), 'twin-smoke-'));
  const file = join(dir, 'twin-smoke.txt');
  writeFileSync(file, `${MARKER}\n`);
  const app = IS_MAC ? 'TextEdit' : 'notepad';
  const info = { app, file, launch: undefined, seen: false, waitedMs: 0, probe: undefined, windowCount: undefined };
  info.launch = IS_MAC
    ? await capture('open', ['-a', 'TextEdit', file])
    : await ps(
        `$process = Start-Process -FilePath notepad -ArgumentList ('"' + $env:TWIN_FILE + '"') -PassThru\n$process.Id`,
        { TWIN_FILE: file },
        { timeoutMs: 30_000 },
      );
  const started = Date.now();
  // If the launch command itself failed there is nothing to wait for. Its error text is already in info.launch.
  while (info.launch.exitCode === 0 && Date.now() - started < 30_000) {
    const probe = IS_MAC
      ? await capture('pgrep', ['-x', 'TextEdit'])
      : await ps(
          `Get-Process -Name notepad -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object Id,MainWindowTitle,SessionId | ConvertTo-Json -Compress`,
          {},
          { timeoutMs: 30_000 },
        );
    info.probe = probe;
    if (probe.exitCode === 0 && probe.stdout.trim()) {
      info.seen = true;
      break;
    }
    await sleep(750);
  }
  info.waitedMs = Date.now() - started;
  await sleep(3000); // let the window settle before anything is measured
  if (IS_MAC) {
    info.windowCount = await capture('osascript', ['-e', 'tell application "System Events" to count windows of process "TextEdit"'], { timeoutMs: 15_000 });
  }
  return info;
}

/** A second app, so that focus has something to change. macOS uses Finder. Windows tries a few small programs. */
export async function launchOtherApp() {
  if (IS_MAC) return { app: 'Finder', launched: undefined };
  const tried = [];
  for (const program of ['mspaint', 'charmap']) {
    const launch = await ps(`Start-Process -FilePath ${program} -PassThru | ForEach-Object { $_.Id }`, {}, { timeoutMs: 30_000 });
    let seen = false;
    for (let attempt = 0; attempt < 20 && launch.exitCode === 0; attempt++) {
      const probe = await ps(
        `Get-Process -Name ${program} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 -ExpandProperty Id`,
        {},
        { timeoutMs: 30_000 },
      );
      if (probe.exitCode === 0 && probe.stdout.trim()) {
        seen = true;
        break;
      }
      await sleep(750);
    }
    tried.push({ program, launch, seen });
    if (seen) {
      await sleep(2000);
      return { app: program, tried };
    }
  }
  return { app: undefined, tried };
}

/** Puts the other app in front by direct OS call, independent of the adapter under test. */
export async function bringOtherForward(otherApp) {
  if (!otherApp) return undefined;
  if (IS_MAC) return capture('open', ['-a', otherApp], { timeoutMs: 15_000 });
  return ps(
    `$p = Get-Process -Name $env:TWIN_APP -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $p) { 'no-window'; exit 2 }
(New-Object -ComObject WScript.Shell).AppActivate($p.Id)`,
    { TWIN_APP: otherApp },
    { timeoutMs: 30_000 },
  );
}

export async function stopApps(names) {
  if (IS_MAC) {
    return Promise.all(names.filter(name => name !== 'Finder').map(name => capture('pkill', ['-x', name])));
  }
  const list = names.map(name => `'${name}'`).join(',');
  return [await ps(`Stop-Process -Name ${list} -Force -ErrorAction SilentlyContinue`, {}, { timeoutMs: 30_000 })];
}

export async function setClipboard(text) {
  return IS_MAC
    ? capture('pbcopy', [], { input: text })
    : ps('Set-Clipboard -Value $env:TWIN_CLIP', { TWIN_CLIP: text }, { timeoutMs: 30_000 });
}

export async function readClipboard() {
  return IS_MAC ? capture('pbpaste') : ps('Get-Clipboard -Raw', {}, { timeoutMs: 30_000 });
}
