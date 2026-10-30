import { execFile } from 'node:child_process';

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
  /** Milliseconds between polls. Windows is slower because each PowerShell call is expensive. */
  readonly pollMs: number;
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
    return (await run('osascript', ['-l', 'JavaScript', '-e', MAC_FOCUS, app])) === 'ok';
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

function encode(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64');
}

const POWERSHELL = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand'];

const windows: Platform = {
  name: 'windows',
  pollMs: 5000,
  async frontmost() {
    const name = await run('powershell.exe', [...POWERSHELL, encode(WIN_FRONTMOST)]);
    return name || undefined;
  },
  async focus(app) {
    const env = { ...process.env, TWIN_APP: app };
    return (await run('powershell.exe', [...POWERSHELL, encode(WIN_FOCUS)], env)) === 'ok';
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
    await run('xdotool', ['search', '--onlyvisible', '--class', `^${escapeRegex(app)}$`, 'windowactivate', '--sync']);
    return true;
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

export interface PlatformChoice {
  platform?: Platform;
  detail: string;
}

/** Picks the adapter for this machine, or explains why app capture is unavailable. Never throws. */
export async function choosePlatform(): Promise<PlatformChoice> {
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
