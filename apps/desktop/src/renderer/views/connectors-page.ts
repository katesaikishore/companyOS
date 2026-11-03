import type { CloudAccountView, TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';
import { button, pageHeader, panel, panelHead } from '../components/ui.js';
import { formatWhen, plural } from '../format.js';
import { LOCAL_CONNECTOR_KINDS, CONNECTORS_NOTE } from '../connectors-model.js';
import { act, bridge, pending, setNotice } from '../store.js';
import { connectorAddButtons, connectorRow } from './settings.js';

/** The cloud accounts the app can connect, in the order the page shows them. */
const CLOUD_PROVIDERS: readonly CloudAccountView['provider'][] = ['googleCalendar', 'github'];
const CLOUD_LABELS: Record<CloudAccountView['provider'], string> = {
  googleCalendar: 'Google Calendar',
  github: 'GitHub',
};

/**
 * The Connectors page: every source the twin reads from, in one place. Local sources are added, read and removed here, as
 * in Settings. Cloud accounts are connected read-only through the person's own sign-in in the browser.
 */
export function connectorsPageView(status: TwinStatus): HTMLElement {
  const now = Date.now();
  const sources = status.config.connectors.filter(source => (LOCAL_CONNECTOR_KINDS as readonly string[]).includes(source.kind));
  return h(
    'div',
    // The rows are the Settings rows, so the page takes the Settings styles.
    { class: 'ov-page settings-view', 'data-testid': 'view-connectors' },
    pageHeader('Connectors', 'Every source the twin reads from. Each one is read on this device, and nothing is sent elsewhere.'),
    panel(
      { testid: 'connectors-local' },
      panelHead('Local sources', CONNECTORS_NOTE),
      status.connectorItems === undefined
        ? null
        : h('p', { class: 'muted small', 'data-testid': 'connectors-total' }, `${plural(status.connectorItems, 'item')} stored from connected sources.`),
      sources.length === 0
        ? h('p', { class: 'muted small', 'data-testid': 'connectors-local-empty' }, 'No local sources connected.')
        : h('div', null, ...sources.map(source => connectorRow(source, status, now))),
      connectorAddButtons(status.config.connectors.length),
    ),
    panel(
      { testid: 'connectors-cloud' },
      panelHead('Cloud accounts', 'Read-only. You sign in through your browser, and the tokens are sealed on this device.'),
      h(
        'div',
        null,
        ...CLOUD_PROVIDERS.map(provider => cloudRow(provider, status.cloudAccounts?.find(account => account.provider === provider))),
        gmailRow(),
      ),
    ),
  );
}

function cloudRow(provider: CloudAccountView['provider'], account: CloudAccountView | undefined): HTMLElement {
  const key = `cloud:${provider}`;
  const configured = account?.configured ?? false;
  const connected = account?.connected ?? false;
  const detail = !configured
    ? 'Not set up in this build'
    : connected
      ? [account?.lastImportedAt ? `last read ${formatWhen(account.lastImportedAt)}` : undefined, account?.count !== undefined ? plural(account.count, 'item') : undefined]
          .filter(Boolean)
          .join(' · ') || 'Connected'
      : 'Not connected';
  return h(
    'div',
    { class: 'settings-row', 'data-testid': `connector-cloud-${provider}` },
    rowText(CLOUD_LABELS[provider], detail),
    !configured
      ? null
      : connected
        ? button('Disconnect', {
            testid: `connector-cloud-disconnect-${provider}`,
            disabled: pending(key),
            onClick: () => void act(key, () => bridge().disconnectCloud(provider)),
          })
        : button('Connect', {
            variant: 'primary',
            testid: `connector-cloud-connect-${provider}`,
            disabled: pending(key),
            onClick: () =>
              void act(key, async () => {
                const count = await bridge().connectCloud(provider);
                setNotice(`Connected. Read ${plural(count, 'item')}.`, 'info');
              }),
          }),
  );
}

/** Gmail has a read-only connector in the core, but this build has no sign-in path for it yet, so the row says so. */
function gmailRow(): HTMLElement {
  return h(
    'div',
    { class: 'settings-row', 'data-testid': 'connector-cloud-gmail' },
    rowText('Gmail', 'Not available in this build yet'),
  );
}

/** A row's name and its state, laid out as the Settings rows are. */
function rowText(title: string, note: string): HTMLElement {
  return h('div', { class: 'settings-model-main' }, h('span', { class: 'settings-row-title' }, title), h('span', { class: 'settings-row-note' }, note));
}
