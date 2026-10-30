import type { NetworkEntry, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { emptyState, fact, pageHeader, panel, panelHead } from '../components/ui.js';
import { formatBytes, formatWhen } from '../format.js';
import { requestRender, state } from '../store.js';

function entryKey(entry: NetworkEntry): string {
  return `${entry.ts}:${entry.modelId ?? entry.host}:${entry.path}`;
}

function purposeLabel(entry: NetworkEntry): string {
  return entry.purpose === 'model_download' ? 'Model download' : 'Update check';
}

/** Plain words for the outcome, verification and failure state of one call. */
function outcomeText(entry: NetworkEntry): string {
  if (entry.purpose === 'update_check') return entry.outcome === 'ok' ? 'feed read' : 'failed';
  const parts: string[] = [];
  if (entry.outcome === 'cancelled') parts.push('cancelled');
  else if (entry.outcome === 'failed') parts.push('failed');
  parts.push(entry.sha256Verified ? 'checksum verified' : 'not verified');
  return parts.join(' · ');
}

function outcomeTone(entry: NetworkEntry): string {
  if (entry.outcome === 'cancelled') return 'muted';
  if (entry.purpose === 'update_check') return entry.outcome === 'ok' ? 'teal' : 'danger';
  return entry.outcome === 'ok' && entry.sha256Verified ? 'teal' : 'danger';
}

export function ledgerView(status: TwinStatus): HTMLElement {
  const entries = [...status.network].reverse();
  const selected = entries.find(entry => entryKey(entry) === state.selectedLedger) ?? entries[0];
  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-ledger' },
    pageHeader(
      'Network ledger',
      'Every model download and update check this device made, exactly as sent. OpenMausBot handoffs are listed on the Agent harness page.',
    ),
    h(
      'section',
      { class: 'tiles', 'aria-label': 'Ledger summary' },
      tile('Allowed hosts', 'huggingface.co, *.hf.co and the update feed', 'Model downloads and update checks only'),
      tile('Personal data in these calls', 'None', 'Nothing about you leaves in these calls'),
      tile('Calls', String(entries.length), 'Every call, newest first'),
    ),
    selected
      ? h(
          'div',
          { class: 'split' },
          requestsPanel(entries, selected),
          detailPanel(selected),
        )
      : panel(
          { testid: 'ledger-empty' },
          emptyState(
            'No network calls yet.',
            'The twin contacts the model host when you install a model, and the update feed only when one is configured.',
          ),
        ),
  );
}

function tile(label: string, value: string, note: string): HTMLElement {
  return h(
    'div',
    { class: 'card tile' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'tile-value' }, value),
    h('span', { class: 'stat-note' }, note),
  );
}

function requestsPanel(entries: readonly NetworkEntry[], selected: NetworkEntry): HTMLElement {
  return panel({ testid: 'ledger-list', labelledBy: 'requests-title' },
    panelHead('Requests', undefined, 'requests-title'),
    h('ol', { class: 'ledger-list' }, ...entries.map(entry => ledgerRow(entry, entry === selected))),
  );
}

function ledgerRow(entry: NetworkEntry, selected: boolean): HTMLElement {
  const key = entryKey(entry);
  return h(
    'li',
    null,
    h(
      'button',
      {
        type: 'button',
        class: selected ? 'ledger-entry is-selected' : 'ledger-entry',
        'data-testid': 'ledger-entry',
        'aria-pressed': String(selected),
        onclick: () => {
          state.selectedLedger = key;
          requestRender();
        },
      },
      h(
        'span',
        { class: 'ledger-top' },
        h('span', { class: 'ledger-purpose' }, purposeLabel(entry)),
        h('span', { class: `ledger-outcome mono small ${outcomeTone(entry)}` }, outcomeText(entry)),
      ),
      h(
        'span',
        { class: 'ledger-meta mono small muted' },
        `${entry.modelId ?? entry.host} · ${formatWhen(entry.ts)} · ${formatBytes(entry.bytes)}`,
      ),
    ),
  );
}

function detailPanel(entry: NetworkEntry): HTMLElement {
  const lines = [
    'Method: GET',
    `Host: ${entry.host}`,
    `Path: ${entry.path}`,
    `Purpose: ${purposeLabel(entry)}`,
    'Body: none',
  ];
  return panel({ testid: 'ledger-detail', labelledBy: 'exact-title' },
    panelHead('Exact request', 'The fields recorded for this call.', 'exact-title'),
    h('pre', { class: 'code-block', 'data-testid': 'ledger-request' }, lines.join('\n')),
    h(
      'dl',
      { class: 'facts' },
      entry.purpose === 'model_download' && fact('Model', entry.modelId),
      fact('Bytes', formatBytes(entry.bytes)),
      fact('Result', outcomeText(entry)),
    ),
  );
}
