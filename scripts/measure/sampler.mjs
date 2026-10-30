// Reads the operating system's process table for the measurement harness. Every reader returns the same rows,
// { pid, ppid, cpuSeconds, rssBytes, command }, where cpuSeconds is cumulative user and kernel time. The parsers are
// pure, so the tests can check them without launching the app.
import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';

const WINDOWS_QUERY =
  'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,KernelModeTime,UserModeTime,Name | ConvertTo-Json -Compress';

/** Parses a ps CPU time, [[DD-]HH:]MM:SS.hh, into seconds. Returns NaN for anything else. */
export function parseCpuTime(text) {
  const dash = text.indexOf('-');
  const days = dash >= 0 ? Number(text.slice(0, dash)) : 0;
  const clock = dash >= 0 ? text.slice(dash + 1) : text;
  const parts = clock.split(':').map(Number);
  if (!Number.isFinite(days) || parts.some(part => !Number.isFinite(part))) return Number.NaN;
  return days * 86_400 + parts.reduce((total, part) => total * 60 + part, 0);
}

/** Parses `ps -axww -o pid=,ppid=,rss=,time=,command=` on macOS. There RSS is in kilobytes. */
export function parsePsTable(text) {
  const rows = [];
  for (const line of text.split('\n')) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s*(.*)$/.exec(line);
    if (!match) continue;
    const cpuSeconds = parseCpuTime(match[4]);
    if (!Number.isFinite(cpuSeconds)) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuSeconds,
      rssBytes: Number(match[3]) * 1024,
      command: match[5],
    });
  }
  return rows;
}

/**
 * Parses one Linux /proc/<pid>/stat and /proc/<pid>/statm pair. The command name sits in parentheses and can contain
 * spaces or parentheses, so the fields are read after the last closing parenthesis.
 */
export function parseProcStat(stat, statm, { clockTicks = 100, pageSize = 4096 } = {}) {
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open < 0 || close < open) return null;
  const fields = stat.slice(close + 2).trim().split(' ');
  const row = {
    pid: Number(stat.slice(0, open).trim()),
    ppid: Number(fields[1]),
    cpuSeconds: (Number(fields[11]) + Number(fields[12])) / clockTicks,
    rssBytes: Number(statm.trim().split(' ')[1]) * pageSize,
    command: stat.slice(open + 1, close),
  };
  const numbers = [row.pid, row.ppid, row.cpuSeconds, row.rssBytes];
  return numbers.every(Number.isFinite) ? row : null;
}

/** Parses the JSON from Get-CimInstance on Windows. KernelModeTime and UserModeTime count 100 ns units. */
export function parseWindowsTable(text) {
  const parsed = JSON.parse(text);
  const list = Array.isArray(parsed) ? parsed : [parsed];
  return list
    .map(item => ({
      pid: Number(item.ProcessId),
      ppid: Number(item.ParentProcessId),
      cpuSeconds: (Number(item.KernelModeTime) + Number(item.UserModeTime)) / 1e7,
      rssBytes: Number(item.WorkingSetSize),
      command: String(item.Name ?? ''),
    }))
    .filter(row => Number.isFinite(row.pid));
}

/** The root process and every process below it, found through parent ids. A root that is gone gives an empty list. */
export function descendantsOf(rows, rootPid) {
  const byPid = new Map(rows.map(row => [row.pid, row]));
  const children = new Map();
  for (const row of rows) {
    const siblings = children.get(row.ppid) ?? [];
    siblings.push(row);
    children.set(row.ppid, siblings);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const found = [root];
  const seen = new Set([rootPid]);
  const queue = [rootPid];
  while (queue.length > 0) {
    const parent = queue.shift();
    for (const child of children.get(parent) ?? []) {
      if (seen.has(child.pid)) continue;
      seen.add(child.pid);
      found.push(child);
      queue.push(child.pid);
    }
  }
  return found;
}

/**
 * CPU as a percentage of one core, summed over the rows, between two readings. A process that was not in the earlier
 * reading counts from zero, since it started during the interval. A process that exited between readings loses its
 * last few milliseconds, which is a small undercount.
 */
export function cpuPercent(previous, rows, elapsedSeconds) {
  if (!(elapsedSeconds > 0)) return 0;
  let used = 0;
  for (const row of rows) used += Math.max(0, row.cpuSeconds - (previous.get(row.pid) ?? 0));
  return (used / elapsedSeconds) * 100;
}

export function sumRss(rows) {
  return rows.reduce((total, row) => total + row.rssBytes, 0);
}

function run(file, args) {
  return new Promise((resolve, reject) => {
    execFile(file, args, { timeout: 10_000, maxBuffer: 16 * 1024 * 1024, windowsHide: true }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

let linuxConstants;
function readLinuxConstants() {
  linuxConstants ??= Promise.all([
    run('getconf', ['CLK_TCK']).then(Number).catch(() => 100),
    run('getconf', ['PAGESIZE']).then(Number).catch(() => 4096),
  ]).then(([clockTicks, pageSize]) => ({ clockTicks, pageSize }));
  return linuxConstants;
}

async function readLinuxTable() {
  const { clockTicks, pageSize } = await readLinuxConstants();
  const names = (await readdir('/proc')).filter(name => /^\d+$/.test(name));
  const rows = await Promise.all(
    names.map(async name => {
      try {
        const [stat, statm] = await Promise.all([
          readFile(`/proc/${name}/stat`, 'utf8'),
          readFile(`/proc/${name}/statm`, 'utf8'),
        ]);
        return parseProcStat(stat, statm, { clockTicks, pageSize });
      } catch {
        return null; // The process exited while it was being read.
      }
    }),
  );
  return rows.filter(Boolean);
}

/** Every process on this machine, in the common row shape. Throws if the OS tool fails. */
export async function readProcessTable(platform = process.platform) {
  if (platform === 'darwin') return parsePsTable(await run('ps', ['-axww', '-o', 'pid=,ppid=,rss=,time=,command=']));
  if (platform === 'linux') return readLinuxTable();
  if (platform === 'win32') {
    return parseWindowsTable(await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY]));
  }
  throw new Error(`Process sampling is not implemented for ${platform}.`);
}
