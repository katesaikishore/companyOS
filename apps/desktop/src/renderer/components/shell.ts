import type { TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { call, type Route } from '../store.js';
import { captureTitle } from '../labels.js';
import { plural } from '../format.js';
import { button, logo } from './ui.js';
import { openCommandPalette } from '../commands.js';
import type { Tone } from '../tones.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

/** One element of an outline icon: its tag and attributes. */
export type Shape = [tag: string, attributes: Record<string, string>];

const OVERVIEW: Shape[] = [
  ['rect', { x: '3', y: '3', width: '7', height: '9', rx: '1.5' }],
  ['rect', { x: '14', y: '3', width: '7', height: '5', rx: '1.5' }],
  ['rect', { x: '14', y: '12', width: '7', height: '9', rx: '1.5' }],
  ['rect', { x: '3', y: '16', width: '7', height: '5', rx: '1.5' }],
];
export const SUGGEST: Shape[] = [
  ['path', { d: 'M9 18h6' }],
  ['path', { d: 'M10 21h4' }],
  ['path', { d: 'M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3z' }],
];
export const AUTOMATE: Shape[] = [
  ['path', { d: 'M4 12a8 8 0 0 1 13.7-5.6L20 9' }],
  ['path', { d: 'M20 4v5h-5' }],
  ['path', { d: 'M20 12a8 8 0 0 1-13.7 5.6L4 15' }],
  ['path', { d: 'M4 20v-5h5' }],
];
/** A checklist: the tasks Recall has assigned, and today's tasks. */
export const TASKS: Shape[] = [
  ['path', { d: 'M10 6h10' }],
  ['path', { d: 'M10 12h10' }],
  ['path', { d: 'M10 18h10' }],
  ['path', { d: 'M4 6l1.6 1.6L8 5' }],
  ['path', { d: 'M4 12l1.6 1.6L8 11' }],
  ['path', { d: 'M4 18l1.6 1.6L8 17' }],
];
/** Three cursors: several automations working at once. */
const SWARM: Shape[] = [
  ['path', { d: 'M4 4l5 12 1.8-5.2L16 9z' }],
  ['path', { d: 'M13 12l3.5 8.5 1.3-3.7 3.7-1.3z' }],
  ['circle', { cx: '18', cy: '5', r: '2' }],
];
/** A plug: the sources the twin reads from, such as folders, Git, calendar and mail. */
const CONNECTORS: Shape[] = [
  ['path', { d: 'M9 3v5' }],
  ['path', { d: 'M15 3v5' }],
  ['path', { d: 'M6 8h12v3a6 6 0 0 1-12 0z' }],
  ['path', { d: 'M12 17v4' }],
];
const LEDGER: Shape[] = [
  ['circle', { cx: '12', cy: '12', r: '9' }],
  ['path', { d: 'M3 12h18' }],
  ['path', { d: 'M12 3c2.5 2.7 3.8 5.7 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-5.7-3.8-9S9.5 5.7 12 3z' }],
];
const SETTINGS: Shape[] = [
  ['path', { d: 'M4 7h10' }],
  ['path', { d: 'M18 7h2' }],
  ['circle', { cx: '16', cy: '7', r: '2' }],
  ['path', { d: 'M4 17h2' }],
  ['path', { d: 'M10 17h10' }],
  ['circle', { cx: '8', cy: '17', r: '2' }],
];
const SEARCH: Shape[] = [
  ['circle', { cx: '11', cy: '11', r: '7' }],
  ['path', { d: 'm20 20-3.5-3.5' }],
];
/** A clock turned back, for what was read or heard earlier. */
const RECALL: Shape[] = [
  ['path', { d: 'M4 12a8 8 0 1 0 2.3-5.6' }],
  ['path', { d: 'M4 4v4.5h4.5' }],
  ['path', { d: 'M12 8v4l2.5 1.5' }],
];
export const LOCK: Shape[] = [
  ['rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }],
  ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }],
];
export const SHIELD: Shape[] = [
  ['path', { d: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z' }],
  ['path', { d: 'm9 12 2 2 4-4' }],
];
export const CHEVRON: Shape[] = [['path', { d: 'm9 6 6 6-6 6' }]];

interface NavItem {
  label: string;
  href: string;
  testid: string;
  icon: Shape[];
  /** The section's colour: its icon tile, and the tint and marker when it is the current page. */
  tone: Tone;
  count?: number;
  /** Shown instead of the count, for a figure such as a percentage. */
  badge?: string;
  /** A count that needs attention is drawn as an accent pill, and no pill is drawn at zero. */
  pill?: boolean;
  active: boolean;
}

export function shell(status: TwinStatus, route: Route, content: Child): HTMLElement {
  const items: NavItem[] = [
    // The review has no link of its own. It is opened from the Overview, so the Overview stays marked while it is shown.
    {
      label: 'Overview',
      href: '#/overview',
      testid: 'nav-overview',
      icon: OVERVIEW,
      tone: 'blue',
      active: route.name === 'overview' || route.name === 'review',
    },
    {
      label: 'Tasks',
      href: '#/tasks',
      testid: 'nav-tasks',
      icon: TASKS,
      tone: 'blue',
      count: status.assignedTasks?.length ?? 0,
      active: route.name === 'tasks',
    },
    {
      label: 'Recall',
      href: '#/recall',
      testid: 'nav-recall',
      icon: RECALL,
      tone: 'blue',
      active: route.name === 'recall',
    },
    {
      label: 'Automations',
      href: '#/automations',
      testid: 'nav-automations',
      icon: AUTOMATE,
      tone: 'green',
      count: status.automations.length,
      active: route.name === 'automations' || route.name === 'automation',
    },
    {
      label: 'Swarm',
      href: '#/swarm',
      testid: 'nav-swarm',
      icon: SWARM,
      tone: 'green',
      count: (status.liveRuns ?? []).filter(run => run.state === 'running').length || undefined,
      active: route.name === 'swarm',
    },
    {
      label: 'Connectors',
      href: '#/connectors',
      testid: 'nav-connectors',
      icon: CONNECTORS,
      tone: 'orange',
      count: status.connectorItems,
      active: route.name === 'connectors',
    },
    {
      label: 'Network ledger',
      href: '#/ledger',
      testid: 'nav-ledger',
      icon: LEDGER,
      tone: 'cyan',
      count: status.network.length,
      active: route.name === 'ledger',
    },
    { label: 'Settings', href: '#/settings', testid: 'nav-settings', icon: SETTINGS, tone: 'steel', active: route.name === 'settings' },
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
        'button',
        {
          type: 'button',
          class: 'command-launch',
          'data-testid': 'command-open',
          'aria-keyshortcuts': 'Control+K Meta+K',
          onclick: openCommandPalette,
        },
        outlineIcon(14, SEARCH, 'command-icon'),
        h('span', { class: 'command-label' }, 'Search'),
        h('kbd', null, 'Ctrl / ⌘ K'),
      ),
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
      class: `nav-item tone-${item.tone}${item.active ? ' is-active' : ''}`,
      href: item.href,
      'aria-current': item.active ? 'page' : undefined,
      'data-testid': item.testid,
    },
    h('span', { class: 'nav-tile' }, outlineIcon(14, item.icon, 'nav-icon')),
    h('span', { class: 'nav-label' }, item.label),
    item.badge !== undefined
      ? h('span', { class: 'nav-count mono' }, item.badge)
      : item.count === undefined || (item.pill && item.count === 0)
        ? undefined
        : h('span', { class: item.pill ? 'nav-count nav-pill mono' : 'nav-count mono' }, String(item.count)),
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
      h('span', { class: 'observing-days mono' }, plural(status.stats.observedDays, 'day')),
    ),
    // The detail can run long in a 216px sidebar, so it is clamped to two lines. The full text is in the tooltip.
    status.capture.detail
      ? h('p', { class: 'muted observing-detail', title: status.capture.detail }, status.capture.detail)
      : undefined,
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

/** A stroked outline icon. It is built in the SVG namespace, which h() does not create. */
export function outlineIcon(size: number, shapes: Shape[], extra?: string): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  const attributes: Record<string, string> = {
    width: String(size),
    height: String(size),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '1.8',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
  };
  for (const [name, value] of Object.entries(attributes)) svg.setAttribute(name, value);
  if (extra) svg.setAttribute('class', extra);
  for (const [tag, shapeAttributes] of shapes) {
    const element = document.createElementNS(SVG_NAMESPACE, tag);
    for (const [name, value] of Object.entries(shapeAttributes)) element.setAttribute(name, value);
    svg.appendChild(element);
  }
  return svg;
}
