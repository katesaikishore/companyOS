import { execFile } from 'node:child_process';
import { readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isSafeFilePath, parseWebAddress, type Executor } from '@companyos/twin-core';

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

/**
 * The real path of a regular file that may be opened, or undefined. A link is followed first, so a link to a program
 * is refused like the program itself. A folder is refused too.
 */
function openableFile(path: string): string | undefined {
  if (!isSafeFilePath(path)) return undefined;
  try {
    const real = realpathSync(path);
    return isSafeFilePath(real) && statSync(real).isFile() ? real : undefined;
  } catch {
    return undefined;
  }
}

function run(file: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      [...args],
      { timeout: 4000, windowsHide: true, env: env ?? process.env, maxBuffer: 64 * 1024 },
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
    const file = openableFile(path);
    return file ? launch('open', ['-a', app, file]) : false;
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
    const file = openableFile(path);
    return file ? openWindows(app, file) : false;
  },
};

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const linuxX11: Platform = {
  name: 'linux-x11',
  pollMs: 3000,
  async frontmost() {
    const windowId = await run('xdotool', ['getactivewindow']);
    const className = await run('xdotool', ['getwindowclassname', windowId]);
    return className || undefined;
  },
  async focus(app) {
    try {
      await run('xdotool', ['search', '--onlyvisible', '--class', `^${escapeRegex(app)}$`, 'windowactivate', '--sync']);
      return true;
    } catch {
      return false;
    }
  },
};

async function hasXdotool(): Promise<boolean> {
  try {
    await run('xdotool', ['version']);
    return true;
  } catch {
    return false;
  }
}

/**
 * The runner's executor for one platform. An optional step is offered only where the adapter has it, so the runner
 * blocks the rest before anyone is asked. Pressing shortcuts has no adapter on any OS yet, so it is always blocked.
 */
export function executorFor(platform: Platform): Executor {
  return {
    focusApp: app => platform.focus(app),
    frontmostApp: () => platform.frontmost(),
    ...(platform.openUrl ? { openUrl: (app: string, url: string) => platform.openUrl?.(app, url) ?? Promise.resolve(false) } : {}),
    ...(platform.openFile ? { openFile: (app: string, path: string) => platform.openFile?.(app, path) ?? Promise.resolve(false) } : {}),
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
    if (await hasXdotool()) return { platform: linuxX11, detail: 'X11 through xdotool' };
    return { detail: 'Install xdotool to enable app capture on X11.' };
  }
  return { detail: `Unsupported platform: ${process.platform}` };
}
