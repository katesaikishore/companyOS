// Turns samples into a summary, checks the summary against the budgets in docs/plan §5.5, and renders the markdown.

/** Budgets from docs/plan §5.5. RSS limits use MiB (1024 × 1024 bytes). The gate is a 30-minute run. */
export const BUDGETS = Object.freeze({ cpuAveragePercent: 1, rssMiB: 150, gateSeconds: 30 * 60 });

export const MIB = 1024 * 1024;

function mean(values) {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

/** Nearest-rank percentile, p from 0 to 1. */
function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1));
  return sorted[index];
}

export function summarize(samples) {
  if (samples.length === 0) throw new Error('No samples were taken.');
  const cpu = samples.map(sample => sample.cpuPercent);
  const rss = samples.map(sample => sample.rssMiB);
  return {
    sampleCount: samples.length,
    cpuPercent: { mean: mean(cpu), p95: percentile(cpu, 0.95), max: Math.max(...cpu) },
    rssMiB: { mean: mean(rss), max: Math.max(...rss) },
  };
}

/**
 * Checks the summary against the budgets. Runs shorter than the gate are "indicative": the numbers are shown with their
 * verdicts, but they do not decide the release gate. RSS must stay under the limit at every sample, so the peak decides.
 */
export function evaluate(summary, durationSeconds) {
  const status = durationSeconds >= BUDGETS.gateSeconds ? 'gate' : 'indicative';
  const rssLimit = `under ${BUDGETS.rssMiB} MiB`;
  const checks = [
    check('CPU, average over the run', summary.cpuPercent.mean, '%', `under ${BUDGETS.cpuAveragePercent}%`,
      summary.cpuPercent.mean < BUDGETS.cpuAveragePercent),
    check('RSS, average over the run', summary.rssMiB.mean, 'MiB', rssLimit, summary.rssMiB.mean < BUDGETS.rssMiB),
    check('RSS, highest sample', summary.rssMiB.max, 'MiB', rssLimit, summary.rssMiB.max < BUDGETS.rssMiB),
  ];
  return { status, checks };
}

function check(metric, measured, unit, limit, pass) {
  return { metric, measured, unit, limit, pass, result: pass ? 'pass' : 'fail' };
}

function fixed(value, digits) {
  return value.toFixed(digits);
}

/** Renders the report as markdown: the budget table first, then the samples and the caveats. */
export function toMarkdown(report) {
  const { run, host, build, summary, checks, status, samples, notes } = report;
  const lines = ['# companyOS Twin resource measurement', ''];
  lines.push(
    status === 'gate'
      ? 'This run covers the 30-minute gate.'
      : '**Indicative only.** This run is shorter than the 30-minute gate, so it does not decide the budgets.',
    '',
  );
  lines.push(`- Generated: ${report.generatedAt}`);
  lines.push(`- Host: ${host.platform} ${host.arch}, ${host.osType} ${host.osRelease}, ${host.cpuModel} (${host.cpuCount} logical CPUs), ${host.memoryMiB} MiB RAM`);
  lines.push(`- Build: commit ${build.commit}${build.dirty ? ' with uncommitted changes' : ''}, app ${build.appVersion}, Electron ${build.electronVersion}`);
  lines.push(`- Run: ${run.durationSeconds} s measured, a sample every ${run.intervalSeconds} s after ${run.warmupSeconds} s of warm-up, ${run.seedDays} seeded days, capture ${run.capture}`);
  lines.push('');
  lines.push('| Metric | Measured | Budget | Result |', '|---|---|---|---|');
  for (const item of checks) {
    const verdict = status === 'gate' ? item.result : `${item.result} (indicative)`;
    lines.push(`| ${item.metric} | ${fixed(item.measured, item.unit === '%' ? 2 : 1)} ${item.unit} | ${item.limit} | ${verdict} |`);
  }
  lines.push('', `Average CPU over the run is the mean of ${summary.sampleCount} samples. The 95th percentile is ${fixed(summary.cpuPercent.p95, 2)}%, and the highest is ${fixed(summary.cpuPercent.max, 2)}%.`, '');
  lines.push('## Samples', '', '| Time (s) | CPU (%) | RSS (MiB) | Processes |', '|---:|---:|---:|---:|');
  for (const sample of samples) {
    lines.push(`| ${sample.t} | ${fixed(sample.cpuPercent, 2)} | ${fixed(sample.rssMiB, 1)} | ${sample.processes} |`);
  }
  lines.push('', '## Notes', '');
  for (const note of notes) lines.push(`- ${note}`);
  return `${lines.join('\n')}\n`;
}
