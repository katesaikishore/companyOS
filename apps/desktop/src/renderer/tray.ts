import type { AutomationView, TwinStatus } from '@companyos/twin-core';
import { h, mount, type Child } from './dom.js';
import { button, logo } from './components/ui.js';
import { clock, startOfDay } from './format.js';
import { captureTitle } from './labels.js';
import { call, refresh, requestRender, setRenderer, state } from './store.js';

const POLL_MS = 2000;

interface TrayRun {
  view: AutomationView;
  run: AutomationView['state']['runs'][number];
  newest: boolean;
}

/** Unattended runs from today, newest first. Only the latest run of each automation can be undone. */
function todaysUnattended(status: TwinStatus): TrayRun[] {
  const since = startOfDay(Date.now());
  const rows: TrayRun[] = [];
  for (const view of status.automations) {
    const runs = view.state.runs;
    const latest = runs[runs.length - 1];
    for (const run of runs) {
      if (run.mode !== 'unattended' || run.ts < since) continue;
      rows.push({ view, run, newest: run === latest && !run.reverted });
    }
  }
  return rows.sort((a, b) => b.run.ts - a.run.ts);
}

function render(): void {
  const root = document.getElementById('tray');
  if (!root) return;
  const status = state.status;
  if (!status) {
    mount(root, h('div', { class: 'tray-card', 'data-testid': 'tray-root' }, h('p', { class: 'tray-muted' }, state.loadError ?? 'Starting…')));
    return;
  }
  const paused = status.capture.state === 'paused';
  const runs = todaysUnattended(status);
  mount(
    root,
    h(
      'div',
      { class: 'tray-card', 'data-testid': 'tray-root' },
      h(
        'header',
        { class: 'tray-head' },
        h(
          'div',
          { class: 'tray-brand' },
          logo(22),
          h(
            'div',
            { class: 'tray-brand-text' },
            h('strong', null, captureTitle(status.capture.state)),
            h('span', { class: 'tray-muted small' }, 'Text-only · screenshots off'),
          ),
        ),
        button(paused ? 'Resume' : 'Pause', {
          testid: 'tray-pause',
          disabled: status.capture.state === 'unsupported',
          onClick: () => void call('tray-pause', twin => twin.setPaused(!paused)),
        }, 'btn-small'),
      ),
      h(
        'div',
        { class: 'tray-body' },
        h(
          'section',
          { class: 'tray-section', 'aria-labelledby': 'tray-ran-title' },
          h('h2', { class: 'tray-eyebrow', id: 'tray-ran-title' }, 'Ran on its own today'),
          runs.length === 0
            ? h('p', { class: 'tray-muted', 'data-testid': 'tray-empty' }, 'Nothing ran on its own today.')
            : h('div', { class: 'tray-runs' }, ...runs.map(trayRunRow)),
        ),
        state.notice ? h('p', { class: `tray-notice notice-${state.notice.tone}` }, state.notice.text) : undefined,
      ),
      h(
        'footer',
        { class: 'tray-foot' },
        button('Stop all automations', {
          variant: 'danger',
          testid: 'tray-stop-all',
          onClick: () => void call('tray-stop', twin => twin.stopAllAutomations()),
        }, 'btn-block tray-stop'),
        h(
          'div',
          { class: 'tray-links' },
          button('Open companyOS', {
            variant: 'link',
            testid: 'tray-open-app',
            onClick: () => void call('tray-open', twin => twin.openMainWindow()),
          }, 'btn-link'),
          button('Network ledger', {
            variant: 'link',
            testid: 'tray-open-ledger',
            onClick: () => void call('tray-ledger', twin => twin.openMainWindow('#/ledger')),
          }, 'btn-link'),
        ),
      ),
    ),
  );
}

function trayRunRow(row: TrayRun): HTMLElement {
  const meta: Child = `${clock(row.run.ts)} · L${row.run.level} · ${row.run.postconditionsFailed === 0 ? 'check passed' : 'check failed'}`;
  return h(
    'div',
    { class: 'tray-run' },
    h(
      'div',
      { class: 'tray-run-text' },
      h('span', { class: 'tray-run-name' }, row.view.automation.name),
      h('span', { class: 'tray-run-meta mono small' }, meta),
    ),
    row.newest
      ? button('Undo', {
          variant: 'ghost',
          testid: 'tray-undo',
          onClick: () => void call(`tray-undo:${row.view.automation.id}`, twin => twin.revertLast(row.view.automation.id)),
        }, 'btn-small tray-undo')
      : undefined,
  );
}

let lastSignature = '';

function signature(): string {
  return JSON.stringify({ status: state.status, loadError: state.loadError, notice: state.notice, pending: [...state.pending].sort(), now: startOfDay(Date.now()) });
}

function paint(): void {
  const current = signature();
  if (current === lastSignature) return;
  lastSignature = current;
  render();
}

async function poll(): Promise<void> {
  if (document.visibilityState === 'visible') await refresh();
  window.setTimeout(() => void poll(), POLL_MS);
}

function boot(): void {
  setRenderer(paint);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });
  void poll();
  requestRender();
}

boot();
