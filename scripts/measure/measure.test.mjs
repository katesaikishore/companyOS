// Tests for the measurement harness. They use recorded command output and fixed numbers, so no app is launched.
// Run with: node --test scripts/measure/measure.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { cpuPercent, descendantsOf, parseCpuTime, parseProcStat, parsePsTable, parseWindowsTable, sumRss } from './sampler.mjs';
import { BUDGETS, MIB, evaluate, summarize, toMarkdown } from './report.mjs';
import { isInsideAppData, parseArgs } from './measure.mjs';

test('parseCpuTime reads ps clock values with and without hours and days', () => {
  assert.equal(parseCpuTime('4:52.11'), 292.11);
  assert.equal(parseCpuTime('1:02:03.45'), 3723.45);
  assert.equal(parseCpuTime('1-00:00:10.00'), 86_410);
  assert.ok(Number.isNaN(parseCpuTime('x:y')));
});

test('parsePsTable reads pid, parent, resident size in kilobytes, CPU time and the command', () => {
  const text = [
    '    1     0  10464  4:52.11 /sbin/launchd',
    '  559     1  13536  7:03.31 /Applications/companyOS Twin.app/Contents/MacOS/companyOS Twin --flag',
    'not a process line',
    '  600   559      0  0:00.00 ',
  ].join('\n');
  const rows = parsePsTable(text);
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[1], {
    pid: 559,
    ppid: 1,
    cpuSeconds: 423.31,
    rssBytes: 13536 * 1024,
    command: '/Applications/companyOS Twin.app/Contents/MacOS/companyOS Twin --flag',
  });
  assert.equal(rows[2].command, '');
});

test('parseProcStat reads fields after the last parenthesis and resident pages from statm', () => {
  // Fields 14 and 15 (utime, stime) are 500 and 300 clock ticks. The name contains parentheses on purpose.
  const stat = '1234 (Electron Helper (GPU)) S 1000 1234 1234 0 -1 4194560 0 0 0 0 500 300 0 0 20 0 5 0 100';
  const statm = '150000 2560 900 1 0 300 0';
  const row = parseProcStat(stat, statm, { clockTicks: 100, pageSize: 4096 });
  assert.deepEqual(row, {
    pid: 1234,
    ppid: 1000,
    cpuSeconds: 8,
    rssBytes: 2560 * 4096,
    command: 'Electron Helper (GPU)',
  });
  assert.equal(parseProcStat('garbage', statm), null);
});

test('parseWindowsTable converts 100 ns counters to seconds and accepts a single object', () => {
  const one = JSON.stringify({ ProcessId: 40, ParentProcessId: 4, WorkingSetSize: 1000, KernelModeTime: 5e7, UserModeTime: 15e7, Name: 'companyOS Twin' });
  // 5e7 + 15e7 units of 100 ns is 20 seconds.
  assert.deepEqual(parseWindowsTable(one), [{ pid: 40, ppid: 4, cpuSeconds: 20, rssBytes: 1000, command: 'companyOS Twin' }]);
  const many = JSON.stringify([
    { ProcessId: 40, ParentProcessId: 4, WorkingSetSize: 1, KernelModeTime: 0, UserModeTime: 0, Name: 'a' },
    { ProcessId: 41, ParentProcessId: 40, WorkingSetSize: 2, KernelModeTime: 1e7, UserModeTime: 0, Name: 'b' },
  ]);
  assert.equal(parseWindowsTable(many).length, 2);
});

test('descendantsOf returns the root and everything below it, and nothing else', () => {
  const rows = [
    { pid: 10, ppid: 1 },
    { pid: 11, ppid: 10 },
    { pid: 12, ppid: 10 },
    { pid: 13, ppid: 11 },
    { pid: 20, ppid: 1 },
  ];
  const found = descendantsOf(rows, 10).map(row => row.pid).sort((a, b) => a - b);
  assert.deepEqual(found, [10, 11, 12, 13]);
  assert.deepEqual(descendantsOf(rows, 999), []);
});

test('cpuPercent sums the CPU time added since the last reading, with new processes counted from zero', () => {
  const previous = new Map([
    [10, 1.0],
    [11, 0.5],
  ]);
  const rows = [
    { pid: 10, cpuSeconds: 1.25 },
    { pid: 11, cpuSeconds: 0.5 },
    { pid: 12, cpuSeconds: 0.1 },
  ];
  // 0.25 + 0 + 0.1 = 0.35 seconds over 5 seconds is 7%.
  assert.ok(Math.abs(cpuPercent(previous, rows, 5) - 7) < 1e-9);
  assert.equal(cpuPercent(previous, rows, 0), 0);
  assert.equal(sumRss([{ rssBytes: 3 }, { rssBytes: 4 }]), 7);
});

test('summarize gives the mean, 95th percentile and maximum of CPU, and the mean and maximum of RSS', () => {
  const samples = Array.from({ length: 20 }, (_, index) => ({ t: (index + 1) * 5, cpuPercent: index + 1, rssMiB: 100 + index }));
  const summary = summarize(samples);
  assert.equal(summary.sampleCount, 20);
  assert.equal(summary.cpuPercent.mean, 10.5);
  assert.equal(summary.cpuPercent.p95, 19);
  assert.equal(summary.cpuPercent.max, 20);
  assert.equal(summary.rssMiB.max, 119);
  assert.throws(() => summarize([]), /No samples/);
});

test('evaluate marks a short run indicative, and a 30-minute run a gate', () => {
  const passing = summarize([
    { t: 5, cpuPercent: 0.4, rssMiB: 120 },
    { t: 10, cpuPercent: 0.6, rssMiB: 130 },
  ]);
  const short = evaluate(passing, 60);
  assert.equal(short.status, 'indicative');
  assert.deepEqual(
    short.checks.map(check => check.result),
    ['pass', 'pass', 'pass'],
  );
  assert.equal(evaluate(passing, BUDGETS.gateSeconds).status, 'gate');
});

test('evaluate fails the RSS budget on the highest sample, not the average', () => {
  const spiky = summarize([
    { t: 5, cpuPercent: 0.2, rssMiB: 100 },
    { t: 10, cpuPercent: 0.2, rssMiB: 100 },
    { t: 15, cpuPercent: 0.2, rssMiB: 160 },
  ]);
  const verdict = evaluate(spiky, BUDGETS.gateSeconds);
  const byMetric = Object.fromEntries(verdict.checks.map(check => [check.metric, check]));
  assert.equal(byMetric['RSS, average over the run'].result, 'pass');
  assert.equal(byMetric['RSS, highest sample'].result, 'fail');
  assert.equal(MIB, 1024 * 1024);
});

test('evaluate fails the CPU budget at one percent or more', () => {
  const busy = summarize([{ t: 5, cpuPercent: 1, rssMiB: 50 }]);
  assert.equal(evaluate(busy, BUDGETS.gateSeconds).checks[0].result, 'fail');
});

test('toMarkdown renders the budget table, the samples and the caveat for a short run', () => {
  const samples = [
    { t: 5, cpuPercent: 0.5, rssMiB: 120.25, processes: 7 },
    { t: 10, cpuPercent: 0.75, rssMiB: 121, processes: 7 },
  ];
  const summary = summarize(samples);
  const verdict = evaluate(summary, 10);
  const markdown = toMarkdown({
    generatedAt: '2026-10-30T00:00:00.000Z',
    host: { platform: 'darwin', arch: 'arm64', osType: 'Darwin', osRelease: '24.6.0', cpuModel: 'Test CPU', cpuCount: 8, memoryMiB: 16384 },
    build: { commit: 'abc1234', dirty: false, appVersion: '0.1.0', electronVersion: '45.1.0' },
    run: { durationSeconds: 10, intervalSeconds: 5, warmupSeconds: 0, seedDays: 10, capture: 'fake' },
    status: verdict.status,
    checks: verdict.checks,
    summary,
    samples,
    notes: ['A note.'],
  });
  assert.match(markdown, /\*\*Indicative only\./);
  assert.match(markdown, /\| CPU, average over the run \| 0\.63 % \| under 1% \| pass \(indicative\) \|/);
  assert.match(markdown, /\| 10 \| 0\.75 \| 121\.0 \| 7 \|/);
  assert.match(markdown, /- A note\./);
});

test('parseArgs applies the defaults and reads the flags', () => {
  const defaults = parseArgs([]);
  assert.equal(defaults.duration, 1800);
  assert.equal(defaults.interval, 5);
  assert.equal(defaults.capture, 'real');
  assert.equal(defaults.seedDays, 10);
  const custom = parseArgs(['--duration', '60', '--capture', 'fake', '--seed-days', '0', '--keep-data']);
  assert.equal(custom.duration, 60);
  assert.equal(custom.capture, 'fake');
  assert.equal(custom.seedDays, 0);
  assert.equal(custom.keepData, true);
});

test('parseArgs rejects bad values with a message that names the flag', () => {
  assert.throws(() => parseArgs(['--duration', 'soon']), /--duration must be a whole number at least 1/);
  assert.throws(() => parseArgs(['--seed-days', '31']), /--seed-days must be a whole number from 0 to 30/);
  assert.throws(() => parseArgs(['--capture', 'video']), /--capture must be real or fake/);
  assert.throws(() => parseArgs(['--duration', '3', '--interval', '5']), /at least --interval/);
  assert.throws(() => parseArgs(['--nope']), /Unknown option/);
  assert.throws(() => parseArgs(['--out']), /needs a value/);
});

test('isInsideAppData refuses the real data folders on each OS and allows anything else', () => {
  const home = '/Users/test';
  assert.equal(
    isInsideAppData(join(home, 'Library', 'Application Support', 'companyOS Twin'), { home, platform: 'darwin', env: {} }),
    true,
  );
  assert.equal(isInsideAppData(join(home, 'Library', 'Application Support'), { home, platform: 'darwin', env: {} }), true);
  assert.equal(isInsideAppData('/var/folders/xy/companyos-measure-1', { home, platform: 'darwin', env: {} }), false);
  assert.equal(isInsideAppData(join(home, 'Library', 'Application Support-test'), { home, platform: 'darwin', env: {} }), false);
  assert.equal(
    isInsideAppData('C:\\Users\\test\\AppData\\Roaming\\companyOS Twin', {
      home: 'C:\\Users\\test',
      platform: 'win32',
      env: { APPDATA: 'C:\\Users\\test\\AppData\\Roaming' },
    }),
    true,
  );
  assert.equal(
    isInsideAppData('/home/test/.config/companyOS Twin', { home: '/home/test', platform: 'linux', env: {} }),
    true,
  );
  assert.equal(isInsideAppData('/tmp/companyos-measure-1', { home: '/home/test', platform: 'linux', env: {} }), false);
});
