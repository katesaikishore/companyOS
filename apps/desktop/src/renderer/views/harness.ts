import type { TwinStatus } from '@companyos/twin-core';
import { h } from '../dom.js';

/** The agent harness page. The harness work builds it out from the handoffs the twin keeps. */
export function harnessView(status: TwinStatus): HTMLElement {
  return h(
    'section',
    { class: 'harness-page', 'data-testid': 'harness-root' },
    h('h1', { class: 'page-title' }, 'Agent harness'),
    h('p', { class: 'muted' }, `${status.handoffs.length} handoffs to OpenMausBot.`),
  );
}
