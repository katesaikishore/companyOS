import { execFile } from 'node:child_process';

/**
 * Reads the text the focused window exposes through the operating system's accessibility interface, which is cleaner than
 * OCR of the picture. Windows uses UI Automation and macOS uses the Accessibility interface through System Events. Password
 * fields are skipped on both. The reader gives up after a few seconds, and it returns nothing rather than an error, so a
 * missing permission only means the screen text is read by OCR alone. Not run on a real Windows or macOS machine yet.
 */
const READ_TIMEOUT_MS = 4_000;
const MAX_TEXT_CHARS = 8_000;
const MAX_ELEMENTS = 400;
const MAX_DEPTH = 10;

/** Joins the reader's lines: trims them, drops empty and repeated lines, and caps the total length. */
export function parseAccessibleText(raw: string): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  let length = 0;
  for (const line of raw.split(/\r?\n/)) {
    let text = line.replace(/\s+/g, ' ').trim();
    if (text === '') continue;
    // A line longer than the room left is cut to that room. Stopping at it would also drop every line after it.
    const room = MAX_TEXT_CHARS - length;
    if (room <= 0) break;
    if (text.length > room) text = text.slice(0, room);
    if (seen.has(text)) continue;
    seen.add(text);
    lines.push(text);
    length += text.length + 1;
  }
  return lines.join('\n');
}

/** The Windows reader, as a PowerShell script. It walks the focused window's controls, breadth first, and prints their text. */
export const WINDOWS_READER = `
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class CompanyOsFocus { [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow(); }
"@
$hwnd = [CompanyOsFocus]::GetForegroundWindow()
if ($hwnd -eq [IntPtr]::Zero) { exit 0 }
$root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
$queue = New-Object System.Collections.Generic.Queue[object]
$queue.Enqueue(@($root, 0))
$count = 0
while ($queue.Count -gt 0 -and $count -lt ${MAX_ELEMENTS}) {
  $item = $queue.Dequeue()
  $element = $item[0]; $depth = $item[1]; $count++
  # Fails closed: when the password flag cannot be read, the element's text is not read.
  $isPassword = $true
  try { $isPassword = [bool]$element.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::IsPasswordProperty) } catch {}
  if (-not $isPassword) {
    $name = $element.Current.Name
    if ($name) { Write-Output $name }
    try {
      $pattern = $null
      if ($element.TryGetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern, [ref]$pattern)) {
        $value = $pattern.Current.Value
        if ($value) { Write-Output $value }
      }
    } catch {}
  }
  if ($depth -lt ${MAX_DEPTH}) {
    $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetFirstChild($element)
    while ($child -ne $null) { $queue.Enqueue(@($child, $depth + 1)); $child = [System.Windows.Automation.TreeWalker]::ControlViewWalker.GetNextSibling($child) }
  }
}
`;

/** The macOS reader, as JavaScript for osascript. It walks the frontmost window's elements and prints their text. */
export const MACOS_READER = `
const events = Application('System Events');
const front = events.processes.whose({ frontmost: true })[0];
const out = [];
let seen = 0;
function read(element, depth) {
  if (seen >= ${MAX_ELEMENTS} || depth > ${MAX_DEPTH}) return;
  seen += 1;
  // A password field is skipped by its role or its subrole. When the role cannot be read, the element's text is not read.
  let secure = true;
  try {
    const role = element.role();
    let subrole = '';
    try { subrole = element.subrole(); } catch (e) {}
    secure = role === 'AXSecureTextField' || subrole === 'AXSecureTextField';
  } catch (e) {}
  if (!secure) {
    for (const get of [() => element.name(), () => element.value()]) {
      try {
        const text = get();
        if (typeof text === 'string' && text.length > 0) out.push(text);
      } catch (e) {}
    }
  }
  let children = [];
  try { children = element.uiElements(); } catch (e) {}
  for (const child of children) read(child, depth + 1);
}
try { read(front.windows[0], 0); } catch (e) {}
out.join('\\n');
`;

/** Runs one reader and returns its text, or '' when it fails, times out, or the platform has none. Never throws. */
export function readAccessibleText(platform: NodeJS.Platform = process.platform): Promise<string> {
  if (platform === 'win32') {
    const encoded = Buffer.from(WINDOWS_READER, 'utf16le').toString('base64');
    return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]);
  }
  if (platform === 'darwin') return run('osascript', ['-l', 'JavaScript', '-e', MACOS_READER]);
  return Promise.resolve('');
}

function run(command: string, args: string[]): Promise<string> {
  return new Promise<string>(resolve => {
    execFile(command, args, { timeout: READ_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024, windowsHide: true }, (_error, stdout) => {
      // A reader that times out or overflows its buffer may still have printed text. That text is kept, since the error
      // would discard all of it. The length cap in parseAccessibleText bounds it.
      resolve(parseAccessibleText(stdout));
    });
  });
}
