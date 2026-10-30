import type { AutomationView, EffectClass, Fit, Param, RunRecord, Step, TwinStatus } from '@companyos/twin-core';
import { formatBytes, clamp01 } from './format.js';

export const LEVEL_NAMES = ['Observe', 'Suggest', 'Draft', 'Run with you', 'On its own', 'External'];

/** Mirrors PROMOTION_RULES in the core engine. The contract does not carry these numbers, so the gate shows them here. */
export const GATE = { supervisedRuns: 10, windowDays: 14, runsInWindow: 25, passRate: 0.99 } as const;

const LOCAL_EFFECTS: readonly EffectClass[] = ['read_only', 'local_reversible'];

export function levelLabel(level: number): string {
  return `L${level} · ${LEVEL_NAMES[level] ?? 'Unknown'}`;
}

export function levelTone(level: number): 'teal' | 'ink' | 'neutral' {
  if (level >= 4) return 'teal';
  if (level === 3) return 'ink';
  return 'neutral';
}

export function effectLabel(effect: EffectClass): string {
  return effect.replace(/_/g, ' ');
}

/**
 * What capture records from browsers, by platform. The browser bridge runs on macOS and Linux only. The setup and
 * settings pages both show this, so they say the same thing. Only what the engine really does is said here.
 */
export function browserCaptureNote(bridgeSupported: boolean): string {
  return bridgeSupported
    ? 'On macOS and Linux, the companyOS Twin extension in Chrome and Edge sends only the host and path shape of the active tab, never a query, a fragment or a title. It never reads a private or incognito window. A page the extension does not send, such as a new tab, and any private window, record only the app name, because the twin cannot tell windows apart. Other browsers record only the app name.'
    : 'Without the browser bridge, as on Windows, Chrome and Edge record only the app name, and their private windows cannot be told apart. Other browsers do the same. No page addresses are recorded.';
}

export function effectsAreLocal(effects: readonly EffectClass[]): boolean {
  return effects.every(effect => LOCAL_EFFECTS.includes(effect));
}

export function fitLabel(fit: Fit): string {
  switch (fit) {
    case 'good':
      return 'Fits comfortably';
    case 'tight':
      return 'Fits, little room';
    case 'too_large':
      return 'Too large for this device';
  }
}

/** The parameter a reference such as "$p1" names, or undefined for a literal value. */
function paramRef(value: string, params: readonly Param[]): Param | undefined {
  return params.find(param => `$${param.name}` === value);
}

export function paramFor(step: Step, params: readonly Param[]): Param | undefined {
  return paramRef(step.app, params);
}

/** The app a step focuses, or the options when the app is a parameter that varies between runs. */
export function stepAppLabel(step: Step, params: readonly Param[]): string {
  const param = paramFor(step, params);
  return param ? param.options.join(' or ') : step.app;
}

/** The host of an address. The path and any query stay out of the label, as they stay out of the store. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** The file name of a path, without its folders. Both separators are handled, so a Windows path reads the same way. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() || path;
}

/** The options a parameter can take, shown in a short form. */
function variesLabel(param: Param, show: (value: string) => string = value => value): string {
  return `varies: ${param.options.map(show).join(' or ')}`;
}

/** The first line of a workflow row: what the step acts on, in plain words. An act names its real target. */
export function stepTitle(step: Step, params: readonly Param[]): string {
  switch (step.op) {
    case 'focus_app':
      return paramFor(step, params) ? 'App chosen for this run' : step.app;
    case 'check_focus':
      return 'Expected app is in front';
    case 'open_url':
      return paramRef(step.url, params) ? 'Link chosen for this run' : `Open ${hostOf(step.url)}`;
    case 'open_file':
      return `Open ${fileNameOf(step.path)}`;
    case 'press_shortcut':
      return `Press ${step.shortcut}`;
  }
}

/** The second line of a workflow row, or undefined when the first line says all there is to say. */
export function stepDetail(step: Step, params: readonly Param[]): string | undefined {
  const appParam = paramFor(step, params);
  if (step.op === 'focus_app') return appParam ? variesLabel(appParam) : undefined;
  const app = appParam ? variesLabel(appParam) : step.app;
  if (step.op !== 'open_url') return app;
  const urlParam = paramRef(step.url, params);
  return urlParam ? `${app} · ${variesLabel(urlParam, hostOf)}` : app;
}

export function appsSummary(view: AutomationView): string {
  const labels: string[] = [];
  for (const step of view.automation.steps) {
    if (step.op !== 'focus_app') continue;
    const label = stepAppLabel(step, view.automation.params);
    if (labels[labels.length - 1] !== label) labels.push(label);
  }
  return labels.join(' → ') || '—';
}

export function passRate(runs: readonly RunRecord[]): number | undefined {
  const passed = runs.reduce((sum, run) => sum + run.postconditionsPassed, 0);
  const failed = runs.reduce((sum, run) => sum + run.postconditionsFailed, 0);
  return passed + failed === 0 ? undefined : passed / (passed + failed);
}

export function runOutcomeLabel(run: RunRecord): string {
  switch (run.status) {
    case 'completed':
      return run.postconditionsFailed === 0 ? 'Passed' : 'Checks failed';
    case 'blocked':
      return 'Blocked';
    case 'failed':
      return 'Failed';
    case 'dry_run':
      return 'Dry run';
  }
}

/** Fraction of the promotion gate met by a value, capped at one. */
export function gateFraction(value: number, target: number): number {
  return clamp01(value / target);
}

const CAPTURE_TITLES: Record<TwinStatus['capture']['state'], string> = {
  capturing: 'Observing',
  paused: 'Paused',
  idle: 'Idle',
  locked: 'Locked',
  unsupported: 'Not available',
};

export function captureTitle(state: TwinStatus['capture']['state']): string {
  return CAPTURE_TITLES[state];
}

export type ModelState = 'not_installed' | 'downloading' | 'installed' | 'cancelled' | 'failed';

/** Derived from the download record and the installed list. Only these five states are shown. */
export function modelState(status: TwinStatus, modelId: string): ModelState {
  const download = status.downloads.find(entry => entry.modelId === modelId);
  if (download?.status === 'running') return 'downloading';
  if (download?.status === 'done' || status.config.installedModels.some(model => model.id === modelId)) return 'installed';
  if (download?.status === 'failed') return 'failed';
  if (download?.status === 'cancelled') return 'cancelled';
  return 'not_installed';
}

export function modelFraction(status: TwinStatus, modelId: string): number {
  if (modelState(status, modelId) === 'installed') return 1;
  const download = status.downloads.find(entry => entry.modelId === modelId);
  if (!download || download.totalBytes <= 0) return 0;
  return clamp01(download.receivedBytes / download.totalBytes);
}

export function modelStateLabel(status: TwinStatus, modelId: string): string {
  const download = status.downloads.find(entry => entry.modelId === modelId);
  switch (modelState(status, modelId)) {
    case 'downloading': {
      if (download && download.totalBytes > 0 && download.receivedBytes >= download.totalBytes) return 'Verifying';
      const received = formatBytes(download?.receivedBytes ?? 0);
      const total = formatBytes(download?.totalBytes ?? 0);
      return `Downloading · ${received} of ${total}`;
    }
    case 'installed':
      return 'Installed';
    case 'failed':
      return download?.message ? `Failed: ${download.message}` : 'Failed';
    case 'cancelled':
      return 'Cancelled';
    case 'not_installed':
      return 'Not installed';
  }
}
