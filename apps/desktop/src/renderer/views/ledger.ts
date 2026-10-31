import type { NetworkEntry, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { emptyState, pageHeader, panel } from '../components/ui.js';
import { formatBytes, formatWhen } from '../format.js';
import { requestRender, state } from '../store.js';

type Tone = 'teal' | 'danger' | 'muted';

function entryKey(entry: NetworkEntry): string {
  return `${entry.ts}:${entry.modelId ?? entry.host}:${entry.path}`;
}

function purposeLabel(entry: NetworkEntry): string {
  return entry.purpose === 'model_download' ? 'Model download' : 'Update check';
}

/** The item a call fetched: the model for a download, the channel file for an update check. */
function itemText(entry: NetworkEntry): string {
  return `${entry.host} · ${entry.modelId ?? entry.path}`;
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

function outcomeTone(entry: NetworkEntry): Tone {
  if (entry.outcome === 'cancelled') return 'muted';
  if (entry.purpose === 'update_check') return entry.outcome === 'ok' ? 'teal' : 'danger';
  return entry.outcome === 'ok' && entry.sha256Verified ? 'teal' : 'danger';
}

/** What the call was checked against. An update check has no digest to compare. */
function checkedText(entry: NetworkEntry): string {
  if (entry.purpose === 'update_check') return 'No checksum to verify';
  return entry.sha256Verified ? 'SHA-256 matched the pinned digest' : 'SHA-256 not verified';
}

export function ledgerView(status: TwinStatus): HTMLElement {
  const entries = [...status.network].reverse();
  const selected = entries.find(entry => entryKey(entry) === state.selectedLedger) ?? entries[0];
  return h(
    'div',
    { class: 'stack ledger-view', 'data-testid': 'view-ledger' },
    pageHeader(
      'Network ledger',
      'Every network call the twin has made. Nothing about you leaves in these calls.',
    ),
    h(
      'section',
      { class: 'tiles ledger-summary', 'aria-label': 'Ledger summary' },
      tile('count', 'Calls so far', String(entries.length), 'Model downloads and update checks only'),
      tile('hosts', 'Allowed hosts', 'huggingface.co · *.hf.co', 'and the update feed, when one is set'),
      tile('clear', 'Personal data sent', 'Nothing', 'GET requests with no body. Hosts see your IP address, which this ledger does not record.'),
    ),
    selected
      ? h('div', { class: 'ledger-split' }, requestsPanel(entries, selected), detailPanel(selected))
      : panel(
          { testid: 'ledger-empty' },
          emptyState(
            'No network calls yet.',
            'The twin contacts the model host when you install a model, and the update feed only when one is configured.',
          ),
        ),
  );
}

function tile(variant: 'count' | 'hosts' | 'clear', label: string, value: string, note: string): HTMLElement {
  return h(
    'div',
    { class: `card ledger-tile is-${variant}` },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'ledger-tile-value' }, value),
    h('span', { class: 'stat-note' }, note),
  );
}

function requestsPanel(entries: readonly NetworkEntry[], selected: NetworkEntry): HTMLElement {
  return panel(
    { testid: 'ledger-list', labelledBy: 'requests-title', extra: 'ledger-table' },
    h('h2', { class: 'ledger-sr', id: 'requests-title' }, 'Requests'),
    h(
      'div',
      { class: 'ledger-head' },
      h('span', null, 'Purpose'),
      h('span', null, 'Host · item'),
      h('span', null, 'Size'),
      h('span', null, 'Result'),
    ),
    h('ol', { class: 'ledger-rows' }, ...entries.map(entry => ledgerRow(entry, entry === selected))),
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
        { class: 'ledger-cell-purpose' },
        h('span', { class: 'ledger-purpose' }, purposeLabel(entry)),
        h('span', { class: 'ledger-when' }, formatWhen(entry.ts)),
      ),
      h('span', { class: 'ledger-item mono' }, itemText(entry)),
      h('span', { class: 'ledger-size mono' }, formatBytes(entry.bytes)),
      h('span', { class: `ledger-result is-${outcomeTone(entry)}` }, outcomeText(entry)),
    ),
  );
}

function detailPanel(entry: NetworkEntry): HTMLElement {
  const lines = [
    `GET ${entry.path}`,
    `Host: ${entry.host}`,
    `Purpose: ${purposeLabel(entry)}`,
    'Method: GET',
    'Body: none',
  ];
  return panel(
    { testid: 'ledger-detail', labelledBy: 'exact-title', extra: 'ledger-detail' },
    h(
      'header',
      { class: 'ledger-detail-head' },
      h('h2', { class: 'ledger-detail-title', id: 'exact-title' }, 'Exact request'),
      h('p', { class: 'ledger-detail-note' }, 'The fields recorded for this call.'),
    ),
    h('pre', { class: 'ledger-raw', 'data-testid': 'ledger-request' }, lines.join('\n')),
    h(
      'dl',
      { class: 'ledger-facts' },
      fact('Purpose', purposeLabel(entry)),
      fact('When', formatWhen(entry.ts)),
      fact('Bytes', formatBytes(entry.bytes), true),
      fact('Checked', checkedText(entry)),
    ),
  );
}

function fact(label: string, value: string, mono = false): HTMLElement {
  return h('div', { class: 'ledger-fact' }, h('dt', null, label), h('dd', mono ? { class: 'mono' } : null, value));
}
