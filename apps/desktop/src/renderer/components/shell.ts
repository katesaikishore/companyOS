import type { TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { call, type Route } from '../store.js';
import { captureTitle } from '../labels.js';
import { button, logo } from './ui.js';

interface NavItem {
  label: string;
  href: string;
  testid: string;
  count?: number;
  active: boolean;
}

export function shell(status: TwinStatus, route: Route, content: Child): HTMLElement {
  const items: NavItem[] = [
    { label: 'Overview', href: '#/overview', testid: 'nav-overview', active: route.name === 'overview' },
    {
      label: 'Suggestions',
      href: '#/suggestions',
      testid: 'nav-suggestions',
      count: status.suggestions.length,
      active: route.name === 'suggestions',
    },
    {
      label: 'Automations',
      href: '#/automations',
      testid: 'nav-automations',
      count: status.automations.length,
      active: route.name === 'automations' || route.name === 'automation',
    },
    {
      label: 'Network ledger',
      href: '#/ledger',
      testid: 'nav-ledger',
      count: status.network.length,
      active: route.name === 'ledger',
    },
    { label: 'Settings', href: '#/settings', testid: 'nav-settings', active: route.name === 'settings' },
  ];

  return h(
    'div',
    { class: 'shell', 'data-testid': 'app-shell' },
    h(
      'aside',
      { class: 'sidebar' },
      h(
        'div',
        { class: 'brand' },
        logo(28),
        h(
          'div',
          { class: 'brand-text' },
          h('span', { class: 'brand-name' }, 'companyOS'),
          h('span', { class: 'brand-sub mono' }, 'twin · on this device'),
        ),
      ),
      h('nav', { class: 'nav', 'aria-label': 'Main' }, ...items.map(navLink)),
      h(
        'div',
        { class: 'sidebar-foot' },
        observingCard(status),
        button(
          'Stop all automations',
          {
            variant: 'danger-outline',
            testid: 'stop-all',
            onClick: () => void call('stop-all', twin => twin.stopAllAutomations()),
          },
          'btn-block',
        ),
      ),
    ),
    h('main', { class: 'main', id: 'main' }, h('div', { class: 'page' }, content)),
  );
}

function navLink(item: NavItem): HTMLElement {
  return h(
    'a',
    {
      class: item.active ? 'nav-item is-active' : 'nav-item',
      href: item.href,
      'aria-current': item.active ? 'page' : undefined,
      'data-testid': item.testid,
    },
    h('span', null, item.label),
    item.count !== undefined ? h('span', { class: 'nav-count mono' }, String(item.count)) : undefined,
  );
}

function observingCard(status: TwinStatus): HTMLElement {
  const captured = status.capture.state;
  const paused = captured === 'paused';
  return h(
    'section',
    { class: 'observing', 'data-testid': 'status-capture', 'aria-label': 'Capture status' },
    h(
      'div',
      { class: 'observing-head' },
      h('span', { class: `dot dot-${captured}`, 'aria-hidden': 'true' }),
      h('strong', null, captureTitle(captured)),
    ),
    h('p', { class: 'muted small' }, 'Records app names and window types. No screenshots, no key contents.'),
    status.capture.detail ? h('p', { class: 'muted small' }, status.capture.detail) : undefined,
    button(
      paused ? 'Resume capture' : 'Pause capture',
      {
        testid: 'capture-toggle',
        disabled: captured === 'unsupported',
        onClick: () => void call('capture', twin => twin.setPaused(!paused)),
      },
      'btn-block',
    ),
  );
}
