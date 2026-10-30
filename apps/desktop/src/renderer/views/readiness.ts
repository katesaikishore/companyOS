import type { TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';

/** The app readiness page. The readiness work builds it out from the engine's figures. */
export function readinessView(status: TwinStatus): HTMLElement {
  return h(
    'section',
    { class: 'readiness-page', 'data-testid': 'readiness-root' },
    h('h1', { class: 'page-title' }, 'App readiness'),
    h('p', { class: 'muted' }, `${status.readiness.automatablePct}% of recent repeated app work could run on its own.`),
  );
}
