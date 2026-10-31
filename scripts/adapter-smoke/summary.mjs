#!/usr/bin/env node
// Turns the two JSON files into Markdown tables for the job summary. It states what happened and nothing more.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OUT_DIR, truncate } from './lib.mjs';

function load(name) {
  const path = join(OUT_DIR, name);
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    return { loadError: String(error.message) };
  }
}

const cell = value => String(value ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').trim();
const clip = (value, limit = 160) => cell(truncate(String(value ?? ''), limit));

/** The first failing command inside a step, as short error text. */
function errorText(step) {
  if (step.error) return step.error.message;
  const failed = (step.subprocesses ?? []).find(item => item.exitCode !== 0 || item.timedOut);
  if (!failed) return '';
  const text = (failed.stderr || failed.stdout || '').trim();
  const program = String(failed.command).split(' ')[0];
  return `${program} exit ${failed.exitCode ?? failed.errorCode}${failed.timedOut ? ' (timed out)' : ''}${text ? `: ${text}` : ''}`;
}

function openVariants(smoke) {
  const step = (smoke.steps ?? []).find(item => item.name === 'Windows open variants');
  const data = step?.result;
  if (!data) return undefined;
  return [
    '| Windows open variant | Start-Process exit | Timed out | After (1.5 s) |',
    '|---|---|---|---|',
    ...data.results.map(r => `| ${cell(r.variant)} | ${r.start.exitCode} | ${r.start.timedOut} | ${clip(r.after, 100)} |`),
    '',
  ];
}

const lines = [];
const smoke = load(`adapter-smoke-${process.platform}.json`);
const desktop = load(`agent-desktop-${process.platform}.json`);
const os = process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : process.platform;

lines.push(`# Adapter smoke on ${os}`, '');
if (smoke) {
  const m = smoke.meta ?? {};
  lines.push(
    `Runner ${cell(m.runnerName)} (${cell(m.runnerOs)} ${cell(m.runnerArch)}, image ${cell(m.imageOs)} ${cell(m.imageVersion)}), kernel ${cell(m.osRelease)}, Node ${cell(m.node)}.`,
    '',
  );
  if (smoke.fatal) lines.push(`**Script stopped early:** ${clip(smoke.fatal.message, 400)}`, '');
  lines.push('## platform.ts adapter', '', '| Step | Result | Front app afterwards | Error text | ms |', '|---|---|---|---|---|');
  for (const step of smoke.steps ?? []) {
    const r = step.result;
    const result =
      r && typeof r === 'object' && 'seen' in r
        ? `window seen=${r.seen}, waited ${r.waitedMs} ms, launch exit ${r.launch?.exitCode ?? r.launch?.errorCode}`
        : r && typeof r === 'object'
          ? JSON.stringify(r)
          : r;
    lines.push(
      `| ${clip(step.name, 70)} | ${clip(result, 110)} | ${clip(step.frontmostAfter ?? step.frontmostAfterError ?? '', 40)} | ${clip(errorText(step), 220)} | ${step.durationMs} |`,
    );
  }
  lines.push(
    '',
    ...(openVariants(smoke) ?? []),
    `Key reached the app (clipboard copy matched the marker line): **${smoke.keyReachedApp}**. Press from another app left the app in front: **${smoke.pressFromOtherAppLeftAppInFront}**.`,
    '',
  );
} else {
  lines.push('No adapter JSON was written.', '');
}

if (desktop) {
  lines.push('## agent-desktop 1.0.2', '');
  if (desktop.fatal) lines.push(`**Script stopped early:** ${clip(desktop.fatal.message, 400)}`, '');
  const b = desktop.binary ?? {};
  lines.push(
    `Binary sha256 ${cell(b.sha256)}; package sidecar matches: ${cell(b.sidecarMatches)}.`,
    '',
    '| Command | Exit codes | ok field | min ms | median ms | max ms |',
    '|---|---|---|---|---|---|',
  );
  for (const call of desktop.calls ?? []) {
    const oks = call.runs.map(run => run.envelope?.ok ?? '-').join(',');
    lines.push(
      `| ${cell(call.command)} | ${call.exitCodes.join(',')} | ${cell(oks)} | ${call.timing?.minMs} | ${call.timing?.medianMs} | ${call.timing?.maxMs} |`,
    );
  }
  if (desktop.pressAfterFocus) {
    const t = desktop.pressAfterFocus.timing;
    lines.push(
      `| ${cell(desktop.pressAfterFocus.command)} (after focus-window) | ${desktop.pressAfterFocus.runs.map(run => run.pressExit).join(',')} | ${desktop.pressAfterFocus.runs.map(run => run.pressEnvelope?.ok ?? '-').join(',')} | ${t?.minMs} | ${t?.medianMs} | ${t?.maxMs} |`,
    );
  }
  if (desktop.pressWithoutFocus) {
    const p = desktop.pressWithoutFocus;
    lines.push(`| press, other app in front, no focus call | ${p.exitCode} | ${p.envelope?.ok ?? '-'} | ${p.durationMs} | | |`);
  }
  lines.push('');
  if (desktop.deliveryChecks?.length) {
    lines.push('| Key delivery check (select all, copy, read clipboard) | Front before | Calls (exit) | Front after | Clipboard matched marker |', '|---|---|---|---|---|');
    for (const check of desktop.deliveryChecks) {
      lines.push(
        `| ${check.withFocusCall ? 'after focus-window' : check.headed ? 'no focus call, --headed' : 'no focus call'} | ${cell(check.frontBefore)} | ${check.calls.map(c => `${c.args.split(' ')[0]}:${c.exitCode}`).join(', ')} | ${cell(check.frontAfter)} | ${check.equalsMarker} |`,
      );
    }
    lines.push('');
  }
} else {
  lines.push('No agent-desktop JSON was written.', '');
}

const text = `${lines.join('\n')}\n`;
writeFileSync(join(OUT_DIR, `summary-${process.platform}.md`), text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text);
console.log(text);
