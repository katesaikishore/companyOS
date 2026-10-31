import { execFile, spawn } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import {
  isShellApp,
  macKeyStroke,
  openableFilePath,
  parseWebAddress,
  StepRefusedError,
  windowsSendKeys,
  xdotoolChord,
  type Executor,
  type FileStat,
} from '@companyos/twin-core';
import { loadDesktopEntries, resolveDesktopEntry, type OpenNeed } from './linux-open';

/**
 * Per-OS access to the frontmost application and to focusing one. This is the only place that
 * shells out. Arguments are passed as arrays, never through a shell. App names are normalised
 * by the core before they reach here.
 *
 * MVP implementations poll and shell out to OS tools. The target is a native helper per OS
 * (Accessibility, UI Automation, AT-SPI) chosen by the spikes in docs/plan.
 */
export interface Platform {
  readonly name: string;
  frontmost(): Promise<string | undefined>;
  focus(app: string): Promise<boolean>;
  /** Opens a checked http or https address in the named browser. Absent where the adapter cannot do it. */
  openUrl?(app: string, url: string): Promise<boolean>;
  /** Opens one checked file in the named application. Absent where the adapter cannot do it. */
  openFile?(app: string, path: string): Promise<boolean>;
  /**
   * Presses a checked key chord in the named application. The adapter brings that app forward and sends the keys only
   * once it is in front. It returns false if the app never comes forward. Absent where the adapter cannot do it.
   */
  pressShortcut?(app: string, shortcut: string): Promise<boolean>;
  /** Milliseconds between polls. Windows is slower because each PowerShell call is expensive. */
  readonly pollMs: number;
}

/** Runs a fixed OS tool with arguments and reports success. Its output and any error text are not kept. */
async function launch(file: string, args: readonly string[]): Promise<boolean> {
  try {
    await run(file, args);
    return true;
  } catch {
    return false;
  }
}

/** Follows any link at the path and reports the real path and whether it is a regular file, or undefined when unreadable. */
function statFile(path: string): FileStat | undefined {
  try {
    const realPath = realpathSync(path);
    return { realPath, isFile: statSync(realPath).isFile() };
  } catch {
    return undefined;
  }
}

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: timeoutMs, windowsHide: true, env: env ?? process.env, maxBuffer: 64 * 1024 },
      (error, stdout) => (error ? reject(error) : resolve(stdout.trim())),
    );
  });
}

const MAC_FRONTMOST = `
function run() {
  const processes = Application('System Events').processes.whose({ frontmost: true });
  return processes.length ? processes[0].name() : '';
}`;

const MAC_FOCUS = `
function run(argv) {
  Application(argv[0]).activate();
  return 'ok';
}`;

/**
 * Brings the app forward, waits until System Events reports it frontmost, and only then sends the key. The request is
 * one JSON argument built from the checked chord. Nothing from the step is ever placed in the script text.
 */
const MAC_PRESS = `
function run(argv) {
  const request = JSON.parse(argv[0]);
  const wanted = request.app.toLowerCase();
  Application(request.app).activate();
  const events = Application('System Events');
  let front = '';
  for (let attempt = 0; attempt < 10; attempt++) {
    const found = events.processes.whose({ frontmost: true });
    front = found.length ? found[0].name().toLowerCase() : '';
    if (front === wanted) break;
    delay(0.15);
  }
  if (front !== wanted) return 'not-front';
  if (request.keyCode !== undefined) {
    events.keyCode(request.keyCode, { using: request.using });
  } else {
    events.keystroke(request.character, { using: request.using });
  }
  return 'ok';
}`;

const macOS: Platform = {
  name: 'macos',
  pollMs: 3000,
  async frontmost() {
    const name = await run('osascript', ['-l', 'JavaScript', '-e', MAC_FRONTMOST]);
    return name || undefined;
  },
  async focus(app) {
    try {
      return (await run('osascript', ['-l', 'JavaScript', '-e', MAC_FOCUS, app])) === 'ok';
    } catch {
      return false;
    }
  },
  // `open -a` names the application, so the link or file opens in that app and brings it forward.
  async openUrl(app, url) {
    const address = parseWebAddress(url)?.href;
    return address ? launch('open', ['-a', app, address]) : false;
  },
  async openFile(app, path) {
    const file = openableFilePath(path, statFile);
    return file ? launch('open', ['-a', app, file]) : false;
  },
  // Needs Accessibility permission for keystrokes through System Events. Not tested on macOS in the build sandbox.
  async pressShortcut(app, shortcut) {
    const stroke = macKeyStroke(shortcut);
    if (!stroke || isShellApp(app)) return false;
    try {
      const request = JSON.stringify({ app, ...stroke });
      return (await run('osascript', ['-l', 'JavaScript', '-e', MAC_PRESS, request])) === 'ok';
    } catch {
      return false;
    }
  },
};

const WIN_FRONTMOST = `
Add-Type -Namespace Twin -Name Fg -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
$processId = [uint32]0
[void][Twin.Fg]::GetWindowThreadProcessId([Twin.Fg]::GetForegroundWindow(), [ref]$processId)
(Get-Process -Id $processId -ErrorAction SilentlyContinue).ProcessName
`;

const WIN_FOCUS = `
$process = Get-Process -Name $env:TWIN_APP -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $process) { exit 2 }
$shell = New-Object -ComObject WScript.Shell
if ($shell.AppActivate($process.Id)) { 'ok' } else { exit 3 }
`;

/** Starts the named program with one quoted argument, an address or a file. Errors stop the script. */
const WIN_OPEN = `
$ErrorActionPreference = 'Stop'
Start-Process -FilePath $env:TWIN_APP -ArgumentList ('"' + $env:TWIN_TARGET + '"')
'ok'
`;

/**
 * Activates the app, waits until its window is the foreground window, and only then sends the keys. The keys come from
 * the environment as a SendKeys string built from the checked chord. Exit codes: 2 not running, 3 not activated,
 * 4 never in front.
 */
const WIN_PRESS = `
$ErrorActionPreference = 'Stop'
$process = Get-Process -Name $env:TWIN_APP -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
if (-not $process) { exit 2 }
Add-Type -Namespace Twin -Name Keys -MemberDefinition @'
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
'@
Add-Type -AssemblyName System.Windows.Forms
$shell = New-Object -ComObject WScript.Shell
if (-not $shell.AppActivate($process.Id)) { exit 3 }
$inFront = $false
for ($attempt = 0; $attempt -lt 10; $attempt++) {
  $foreground = [uint32]0
  [void][Twin.Keys]::GetWindowThreadProcessId([Twin.Keys]::GetForegroundWindow(), [ref]$foreground)
  if ($foreground -eq [uint32]$process.Id) { $inFront = $true; break }
  Start-Sleep -Milliseconds 150
}
if (-not $inFront) { exit 4 }
[System.Windows.Forms.SendKeys]::SendWait($env:TWIN_KEYS)
'ok'
`;

function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

/** The target goes through the environment, never the script text, so a name or path cannot change the command. */
async function openWindows(app: string, target: string): Promise<boolean> {
  const env = { ...process.env, TWIN_APP: app, TWIN_TARGET: target };
  try {
    return (await run('powershell.exe', [...POWERSHELL, encode(WIN_OPEN)], env)) === 'ok';
  } catch {
    return false;
  }
}

const windows: Platform = {
  name: 'windows',
  pollMs: 5000,
  async frontmost() {
    const name = await run('powershell.exe', [...POWERSHELL, encode(WIN_FRONTMOST)]);
    return name || undefined;
  },
  async focus(app) {
    const env = { ...process.env, TWIN_APP: app };
    try {
      return (await run('powershell.exe', [...POWERSHELL, encode(WIN_FOCUS)], env)) === 'ok';
    } catch {
      return false; // Exit code 2 means the app is not running. Errors carry the command text, so they are not surfaced.
    }
  },
  async openUrl(app, url) {
    const address = parseWebAddress(url)?.href;
    return address ? openWindows(app, address) : false;
  },
  async openFile(app, path) {
    const file = openableFilePath(path, statFile);
    return file ? openWindows(app, file) : false;
  },
  // Not tested on Windows in the build sandbox. SendKeys cannot reach an elevated window from a normal process.
  async pressShortcut(app, shortcut) {
    const keys = windowsSendKeys(shortcut);
    if (!keys || isShellApp(app)) return false;
    const env = { ...process.env, TWIN_APP: app, TWIN_KEYS: keys };
    try {
      // Longer than the default: PowerShell starts slowly and compiles a small type before it sends any keys.
      return (await run('powershell.exe', [...POWERSHELL, encode(WIN_PRESS)], env, 10_000)) === 'ok';
    } catch {
      return false;
    }
  },
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * The class name in an xprop WM_CLASS line, such as: WM_CLASS(STRING) = "instance", "Class". xprop writes a quote or a
 * backslash as a backslash escape, and a byte outside ASCII as a three-digit octal escape. The escapes are decoded to
 * bytes, and the bytes are read as UTF-8. A line with one string has an instance name only, so it has no class.
 */
export function wmClassName(line: string): string | undefined {
  const quoted = [...line.matchAll(/"((?:[^"\\]|\\.)*)"/g)];
  if (quoted.length < 2) return undefined;
  const chars = Array.from(quoted[1][1]);
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    if (chars[i] !== '\\') {
      bytes.push(...Buffer.from(chars[i], 'utf8'));
      continue;
    }
    const octal = chars.slice(i + 1, i + 4).join('');
    if (/^[0-7]{3}$/.test(octal)) {
      bytes.push(parseInt(octal, 8));
      i += 3;
    } else {
      bytes.push(...Buffer.from(chars[i + 1] ?? '', 'utf8'));
      i += 1;
    }
  }
  return Buffer.from(bytes).toString('utf8') || undefined;
}

/** Asks the window manager to bring the app's visible windows forward. False when it has none or the call fails. */
async function activateX11(app: string, timeoutMs = 4000): Promise<boolean> {
  try {
    await run('xdotool', ['search', '--onlyvisible', '--class', `^${escapeRegex(app)}$`, 'windowactivate', '--sync'], undefined, timeoutMs);
    return true;
  } catch {
    return false;
  }
}

const linuxX11: Platform = {
  name: 'linux-x11',
  pollMs: 3000,
  async frontmost() {
    // xdotool on Ubuntu 24.04 has no getwindowclassname, so the class is read from the window's WM_CLASS property. A
    // failed lookup means no app is in front, so it is reported as undefined rather than thrown.
    try {
      const windowId = await run('xdotool', ['getactivewindow']);
      if (!windowId) return undefined;
      return wmClassName(await run('xprop', ['-id', windowId, 'WM_CLASS']));
    } catch {
      return undefined;
    }
  },
  async focus(app) {
    return activateX11(app);
  },
  /**
   * Brings the app forward, then checks that the active window is one of that app's windows before it sends the keys. If
   * the check fails, nothing is sent. The keys go through XTEST, the same path as xdotool's own key command, which did not
   * crash the test apps in the checks that were run. The agent-desktop CLI's press did, so it is not used here.
   */
  async pressShortcut(app, shortcut) {
    const chord = xdotoolChord(shortcut);
    if (!chord) return false;
    try {
      const pattern = `^${escapeRegex(app)}$`;
      await run('xdotool', ['search', '--onlyvisible', '--class', pattern, 'windowactivate', '--sync']);
      const active = await run('xdotool', ['getactivewindow']);
      const ours = (await run('xdotool', ['search', '--onlyvisible', '--class', pattern])).split(/\s+/);
      if (!active || !ours.includes(active)) return false;
      await run('xdotool', ['key', '--clearmodifiers', chord]);
      return true;
    } catch {
      return false;
    }
  },
};

/** How long `gio launch` may run before it is stopped. It hands the app over and exits, so a normal call takes milliseconds. */
const LAUNCH_TIMEOUT_MS = 8000;
/**
 * After a launch, the app is asked to come forward up to this many times, so a window that opens late is still caught. The
 * whole effort stops at the budget, because a window manager that refuses can leave one request waiting until it times out.
 */
const FORWARD_ATTEMPTS = 6;
const FORWARD_DELAY_MS = 250;
const FORWARD_BUDGET_MS = 4000;
const FORWARD_CALL_MS = 2000;

/**
 * Starts a program with an argument array, no shell and none of its standard streams, and reports whether it exited with
 * status 0 within the time limit. A program that is still running at the limit is killed by its process ID. The streams are
 * closed on purpose. The program hands the target to an app and exits, and an app that inherited a pipe would hold it open
 * for as long as it runs. A call that waits for its pipes, such as execFile, would then not return until the app quit. Its
 * output and any error text are not kept.
 */
export function launchDetached(file: string, args: readonly string[], timeoutMs = LAUNCH_TIMEOUT_MS): Promise<boolean> {
  return new Promise(resolve => {
    let timer: NodeJS.Timeout | undefined;
    let settled = false;
    const finish = (ok: boolean): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(ok);
    };
    try {
      const child = spawn(file, [...args], { stdio: 'ignore', windowsHide: true, env: process.env });
      timer = setTimeout(() => {
        child.kill('SIGKILL');
        finish(false);
      }, timeoutMs);
      child.once('error', () => finish(false));
      child.once('exit', code => finish(code === 0));
    } catch {
      finish(false);
    }
  });
}

/** Asks for the app to come forward a few times, because its window may not exist yet. It never fails: the runner checks the result. */
async function bringForward(app: string): Promise<void> {
  const deadline = Date.now() + FORWARD_BUDGET_MS;
  for (let attempt = 0; attempt < FORWARD_ATTEMPTS && Date.now() < deadline; attempt++) {
    if (await activateX11(app, Math.min(FORWARD_CALL_MS, deadline - Date.now()))) return;
    await new Promise(resolve => setTimeout(resolve, FORWARD_DELAY_MS));
  }
}

/** Why a link or file was not opened, in words safe to show. None of them carries the app name, a path or an address. */
const OPEN_REFUSALS = {
  not_found: 'No installed application matches that name. Use the name its window has, or its name in the application menu.',
  ambiguous: 'More than one installed application matches that name, so nothing was opened.',
  cannot_open_url: 'That application does not take a web address.',
  cannot_open_file: 'That application does not take a file.',
} as const;

/**
 * Opens one checked target in the named app on Linux. The name is resolved to one desktop entry that can take the
 * target, and that entry's file is launched with the target as its only argument. An app that cannot be resolved is
 * refused and nothing is launched. After the launch the app is asked to come forward, since the window manager may not do it
 * for a window it did not see a user ask for. The runner then checks that the app is in front.
 */
async function openOnLinux(app: string, need: OpenNeed, target: string): Promise<boolean> {
  const resolved = resolveDesktopEntry(app, loadDesktopEntries(), need);
  if (!resolved.ok) {
    throw new StepRefusedError(
      resolved.reason === 'cannot_open' ? OPEN_REFUSALS[need.kind === 'url' ? 'cannot_open_url' : 'cannot_open_file'] : OPEN_REFUSALS[resolved.reason],
    );
  }
  if (!(await launchDetached('gio', ['launch', resolved.entry.file, target]))) return false;
  await bringForward(app);
  return true;
}

const linuxOpenSteps: Required<Pick<Platform, 'openUrl' | 'openFile'>> = {
  async openUrl(app, url) {
    const address = parseWebAddress(url);
    if (!address) return false;
    return openOnLinux(app, { kind: 'url', scheme: address.protocol === 'https:' ? 'https' : 'http' }, address.href);
  },
  async openFile(app, path) {
    const file = openableFilePath(path, statFile);
    if (!file || isShellApp(app)) return false;
    return openOnLinux(app, { kind: 'file' }, file);
  },
};

/** True when both X11 tools are installed: xdotool for windows and keys, and xprop (from x11-utils) for the class name. */
async function hasX11Tools(): Promise<boolean> {
  try {
    await run('xdotool', ['version']);
    await run('xprop', ['-version']);
    return true;
  } catch {
    return false;
  }
}

/** True when `gio launch` exists. It was added in GLib 2.50. The help call fails on a gio that does not have the command. */
async function hasGioLaunch(): Promise<boolean> {
  try {
    await run('gio', ['help', 'launch']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runner's executor for one platform. An optional step is offered only where the adapter has it, so the runner
 * blocks the rest before anyone is asked. Pressing a shortcut is offered on macOS, on Windows and on X11 through xdotool.
 * Opening a link or a file is offered on macOS, on Windows and on X11 when gio is installed. Elsewhere, such as Wayland,
 * the runner blocks those steps before anyone is asked.
 */
export function executorFor(platform: Platform): Executor {
  return {
    focusApp: app => platform.focus(app),
    frontmostApp: () => platform.frontmost(),
    ...(platform.openUrl ? { openUrl: (app: string, url: string) => platform.openUrl?.(app, url) ?? Promise.resolve(false) } : {}),
    ...(platform.openFile ? { openFile: (app: string, path: string) => platform.openFile?.(app, path) ?? Promise.resolve(false) } : {}),
    ...(platform.pressShortcut
      ? { pressShortcut: (app: string, shortcut: string) => platform.pressShortcut?.(app, shortcut) ?? Promise.resolve(false) }
      : {}),
  };
}

export interface PlatformChoice {
  platform?: Platform;
  detail: string;
}

/** Picks the adapter for this machine, or explains why app capture is unavailable. Never throws. */
/**
 * Test-only. COMPANYOS_TEST_FAKE_PLATFORM=<file> makes the front app whatever the file says, and a focus
 * writes the app name to it. The end-to-end tests use it to drive real capture, offers and runs on a
 * machine with no display tools. Never set it for real use.
 */
function fakePlatform(file: string): Platform {
  return {
    name: 'test-platform',
    pollMs: 300,
    async frontmost() {
      try {
        return readFileSync(file, 'utf8').trim() || undefined;
      } catch {
        return undefined;
      }
    },
    async focus(app) {
      writeFileSync(file, app);
      return true;
    },
  };
}

export async function choosePlatform(): Promise<PlatformChoice> {
  const fake = process.env.COMPANYOS_TEST_FAKE_PLATFORM;
  if (fake) return { platform: fakePlatform(fake), detail: 'Test platform' };
  if (process.platform === 'darwin') {
    return { platform: macOS, detail: 'macOS: the first capture may ask for Automation permission.' };
  }
  if (process.platform === 'win32') return { platform: windows, detail: 'Windows' };
  if (process.platform === 'linux') {
    if (process.env.XDG_SESSION_TYPE === 'wayland') {
      return { detail: 'Wayland: app capture needs a compositor extension and is not available yet.' };
    }
    if (!process.env.DISPLAY) return { detail: 'No display found.' };
    if (await hasX11Tools()) {
      if (await hasGioLaunch()) {
        return { platform: { ...linuxX11, ...linuxOpenSteps }, detail: 'X11 through xdotool and xprop. Links and files open through gio.' };
      }
      return { platform: linuxX11, detail: 'X11 through xdotool and xprop. Install gio (libglib2.0-bin) to open links and files.' };
    }
    return { detail: 'Install xdotool and x11-utils (xprop) to enable app capture on X11.' };
  }
  return { detail: `Unsupported platform: ${process.platform}` };
}
