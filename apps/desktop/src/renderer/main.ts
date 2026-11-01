import type { TwinStatus } from '@companyos/twin-core';
import { h, mount } from './dom.js';
import { shell } from './components/shell.js';
import { openCommandPalette } from './commands.js';
import { layaFraction, layaStateLabel, modelFraction, modelStateLabel } from './labels.js';
import { automationDetailView, automationsView } from './views/automations.js';
import { ledgerView } from './views/ledger.js';
import { readinessView } from './views/readiness.js';
import { overviewView } from './views/overview.js';
import { settingsView } from './views/settings.js';
import { setupView } from './views/setup.js';
import { suggestionsView } from './views/suggestions.js';
import {
  bridge,
  go,
  refresh,
  requestRender,
  routeFromHash,
  routeKey,
  setKicker,
  setRenderer,
  state,
  type Route,
} from './store.js';

function requireElement(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id} in index.html`);
  return el;
}

const appRoot = requireElement('app');
const noticeRoot = requireElement('notice');
const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

let lastSignature = '';
let lastRouteKey = '';
let pollTimer: number | undefined;

/** Resolves the saved theme ("system", "light" or "dark") to the attribute the CSS reads. */
function applyTheme(status: TwinStatus): void {
  const preference = status.config.theme;
  const dark = preference === 'dark' || (preference === 'system' && systemDark.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

function paintNotice(): void {
  const notice = state.notice;
  noticeRoot.hidden = !notice;
  noticeRoot.className = notice ? `notice notice-${notice.tone}` : 'notice';
  if (!notice) {
    noticeRoot.replaceChildren();
    return;
  }
  mount(
    noticeRoot,
    h('span', { class: 'notice-text' }, notice.text),
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost btn-small',
        'data-testid': 'notice-dismiss',
        onclick: () => {
          state.notice = undefined;
          paintNotice();
        },
      },
      'Dismiss',
    ),
  );
}

/**
 * Everything the view depends on except download byte counts, which are patched in place every poll.
 * Comparing it avoids rebuilding the page when nothing changed, so buttons and focus are not disturbed.
 */
function signature(status: TwinStatus | undefined): string {
  return JSON.stringify({
    route: routeKey(state.route),
    status: status && {
      ...status,
      downloads: status.downloads.map(download => ({
        modelId: download.modelId,
        status: download.status,
        message: download.message,
      })),
      // Like the model downloads, the byte count is patched in place every poll.
      laya: { ...status.laya, receivedBytes: 0, file: undefined },
    },
    loadError: state.loadError,
    pending: [...state.pending].sort(),
    wizard: [state.wizardForced, state.wizardStep, state.altOpen],
    setup: state.setup,
    selection: [state.selectedSuggestion, state.selectedLedger, state.automationTab],
    runs: [...state.runResults.entries()],
  });
}

function patchLive(status: TwinStatus): void {
  document.querySelectorAll<HTMLElement>('[data-label-model]').forEach(el => {
    const id = el.dataset.labelModel;
    if (id) el.textContent = modelStateLabel(status, id);
  });
  document.querySelectorAll<HTMLElement>('[data-progress-model]').forEach(el => {
    const id = el.dataset.progressModel;
    if (!id) return;
    const pct = Math.round(modelFraction(status, id) * 100);
    el.setAttribute('aria-valuenow', String(pct));
    const fill = el.firstElementChild;
    if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
  });
  document.querySelectorAll<HTMLElement>('[data-label-laya]').forEach(el => {
    el.textContent = layaStateLabel(status.laya);
  });
  document.querySelectorAll<HTMLElement>('[data-progress-laya]').forEach(el => {
    const pct = Math.round(layaFraction(status.laya) * 100);
    el.setAttribute('aria-valuenow', String(pct));
    const fill = el.firstElementChild;
    if (fill instanceof HTMLElement) fill.style.width = `${pct}%`;
  });
}

function viewFor(status: TwinStatus, route: Route): HTMLElement {
  switch (route.name) {
    case 'suggestions':
      return suggestionsView(status);
    case 'automations':
      return automationsView(status);
    case 'automation':
      return automationDetailView(status, route.id);
    case 'ledger':
      return ledgerView(status);
    case 'readiness':
      return readinessView(status, route.app);
    case 'settings':
      return settingsView(status);
    default:
      return overviewView(status);
  }
}

function render(): void {
  const status = state.status;
  paintNotice();
  if (!status) {
    mount(
      appRoot,
      h('div', { class: 'boot' }, h('p', null, 'Starting…'), state.loadError ? h('p', { class: 'muted small' }, state.loadError) : undefined),
    );
    return;
  }
  applyTheme(status);

  const key = routeKey(state.route);
  const signed = signature(status);
  if (signed === lastSignature) {
    patchLive(status);
    return;
  }
  // Unsaved input on this route: keep the DOM as it is. The next change after the input is saved will redraw.
  if (state.dirty.size > 0 && key === lastRouteKey) {
    patchLive(status);
    return;
  }

  lastSignature = signed;
  lastRouteKey = key;
  const wizardOpen = !status.config.setupCompleted || state.wizardForced;
  mount(appRoot, wizardOpen ? setupView(status) : shell(status, state.route, viewFor(status, state.route)));
  patchLive(status);
}

function schedulePoll(delay: number): void {
  window.clearTimeout(pollTimer);
  pollTimer = window.setTimeout(() => void poll(), delay);
}

/** Polls every two seconds while the window is visible, and every second while a download runs. */
async function poll(): Promise<void> {
  if (document.visibilityState === 'visible') await refresh();
  const downloading = state.status?.downloads.some(download => download.status === 'running') ?? false;
  schedulePoll(downloading ? 1000 : 2000);
}

function boot(): void {
  state.route = routeFromHash(location.hash);
  setRenderer(render);
  setKicker(() => schedulePoll(300));

  window.addEventListener('hashchange', () => {
    state.route = routeFromHash(location.hash);
    state.dirty.clear();
    requestRender();
  });

  window.addEventListener('keydown', event => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
      event.preventDefault();
      if (state.status?.config.setupCompleted && !state.wizardForced) openCommandPalette();
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') void refresh();
  });

  systemDark.addEventListener('change', () => {
    if (state.status) applyTheme(state.status);
  });

  try {
    // The main process can ask this page to change route, for example when a tray action opens the ledger.
    bridge().onNavigate(route => go(route));
  } catch {
    // The bridge may not offer navigation in an older build. Hash links still work.
  }

  void poll();
}

boot();
