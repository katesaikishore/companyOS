import type {
  AppReadinessRoutineView,
  AppReadinessRow,
  AppReadinessStatus,
  AppReadinessView,
  GateRequirement,
  TwinStatus,
} from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { chip, emptyState, pageHeader, panelHead, progressBar, type ChipTone } from '../components/ui.js';
import { plural, titleCase, titleCaseSequence } from '../format.js';
import { levelLabel, levelTone } from '../labels.js';
import { requestRender } from '../store.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** The ring is drawn in a 120 unit box. Its arcs are lengths along a circle of this radius. */
const RING_RADIUS = 50;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const STATUS_CHIPS: Record<AppReadinessStatus, { label: string; tone: ChipTone }> = {
  automatable: { label: 'Automatable', tone: 'teal' },
  partly: { label: 'Partly automatable', tone: 'ink' },
  approval: { label: 'Needs approval', tone: 'warn' },
  not_yet: { label: 'Learning', tone: 'neutral' },
};

type ReadinessFilter = 'all' | 'automatable' | 'approval' | 'not_yet';

/** The groups the app list can show. A partly automatable app is in the automatable group. */
const FILTERS: readonly { id: ReadinessFilter; label: string; statuses: readonly AppReadinessStatus[] }[] = [
  { id: 'all', label: 'All', statuses: ['automatable', 'partly', 'approval', 'not_yet'] },
  { id: 'automatable', label: 'Automatable', statuses: ['automatable', 'partly'] },
  { id: 'approval', label: 'Needs approval', statuses: ['approval'] },
  { id: 'not_yet', label: 'Learning', statuses: ['not_yet'] },
];

/** The group the list shows. It is kept here, not in the page, because a refresh draws the page again. */
let listFilter: ReadinessFilter = 'all';

/** The app readiness page: the overview of every app, or one app's detail when the route names it. */
export function readinessView(status: TwinStatus, app?: string): HTMLElement {
  return app === undefined ? listPage(status.readiness) : detailPage(status.readiness, app);
}

/** The sentence under the banner. It states the overall automatable share in whole percent, and names no band. */
export function readinessSentence(automatablePct: number): string {
  return `${automatablePct}% of your app switches could run on its own.`;
}

/** How many routines use an app, with the verb to match: "1 routine uses this app", "2 routines use this app". */
export function routineUseLabel(count: number): string {
  return `${plural(count, 'routine')} ${count === 1 ? 'uses' : 'use'} this app`;
}

function listPage(readiness: AppReadinessView): HTMLElement {
  const hasSwitches = readiness.switches > 0;
  const body: Child = hasSwitches ? [banner(readiness), appTable(readiness.rows)] : emptyPanel();
  return h(
    'div',
    { class: 'stack readiness-page readiness-fill', 'data-testid': 'readiness-root' },
    pageHeader(
      'App readiness',
      "How much of each app's switches could run on its own · past 7 days",
      hasSwitches ? filterGroup() : undefined,
    ),
    body,
  );
}

function emptyPanel(): HTMLElement {
  return h(
    'section',
    { class: 'panel', 'data-testid': 'readiness-empty' },
    emptyState(
      'No app switches in the last 7 days yet.',
      'The twin records app names and timing, not content. Repeated sequences appear here once the same apps recur over a few days.',
    ),
  );
}

/** The filter over the app list. It uses the segmented control that Settings uses. */
function filterGroup(): HTMLElement {
  return h(
    'div',
    { class: 'segmented', role: 'group', 'aria-label': 'Filter apps' },
    ...FILTERS.map(filter => {
      const on = filter.id === listFilter;
      return h(
        'button',
        {
          type: 'button',
          class: on ? 'seg is-on' : 'seg',
          'aria-pressed': String(on),
          'data-testid': `readiness-filter-${filter.id}`,
          onclick: () => {
            listFilter = filter.id;
            requestRender();
          },
        },
        filter.label,
      );
    }),
  );
}

/** The dark summary: the automatable share as a ring, the sentence for it, and the three groups as legend items. */
function banner(readiness: AppReadinessView): HTMLElement {
  return h(
    'section',
    { class: 'readiness-banner', 'aria-label': 'Overall readiness', 'data-testid': 'readiness-banner' },
    ring(readiness),
    h(
      'div',
      { class: 'readiness-banner-copy' },
      h('p', { class: 'readiness-sentence' }, readinessSentence(readiness.automatablePct)),
      h(
        'p',
        { class: 'readiness-banner-sub' },
        `Only routines made of local, reversible steps count. ${plural(readiness.switches, 'switch', 'switches')} across ${plural(readiness.apps, 'app')}.`,
      ),
    ),
    h(
      'dl',
      { class: 'readiness-legend' },
      legendChip('Automatable', readiness.automatablePct, 'readiness-swatch-auto'),
      legendChip('Approval', readiness.approvalPct, 'readiness-swatch-ask'),
      legendChip('Not yet', readiness.notYetPct, 'readiness-swatch-rest'),
    ),
  );
}

/** The automatable share as the green arc, the approval share after it, and the rest as the track. */
function ring(readiness: AppReadinessView): HTMLElement {
  const automatable = (RING_LENGTH * readiness.automatablePct) / 100;
  const approval = (RING_LENGTH * readiness.approvalPct) / 100;
  const geometry = { cx: '60', cy: '60', r: String(RING_RADIUS), fill: 'none', 'stroke-width': '14' };
  return h(
    'div',
    { class: 'readiness-ring-wrap' },
    svgElement(
      'svg',
      { viewBox: '0 0 120 120', class: 'readiness-ring', 'aria-hidden': 'true' },
      svgElement('circle', { ...geometry, class: 'readiness-ring-track' }),
      svgElement('circle', {
        ...geometry,
        class: 'readiness-ring-ask',
        'stroke-dasharray': `${approval} ${RING_LENGTH}`,
        'stroke-dashoffset': String(-automatable),
      }),
      svgElement('circle', {
        ...geometry,
        class: 'readiness-ring-auto',
        'stroke-dasharray': `${automatable} ${RING_LENGTH}`,
      }),
    ),
    h('span', { class: 'readiness-ring-value' }, `${readiness.automatablePct}%`),
  );
}

function svgElement(tag: string, attributes: Record<string, string>, ...children: SVGElement[]): SVGElement {
  const element = document.createElementNS(SVG_NAMESPACE, tag);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, value);
  element.append(...children);
  return element;
}

function legendChip(label: string, value: number, swatch: string): HTMLElement {
  return h(
    'div',
    { class: 'readiness-legend-item' },
    h('dt', { class: 'readiness-legend-label' }, h('span', { class: `readiness-swatch ${swatch}`, 'aria-hidden': 'true' }), label),
    h('dd', { class: 'readiness-legend-value' }, `${value}%`),
  );
}

/** The rows of the list group in view, or the one group's empty line. The notes under the table say what the figures rest on. */
function appTable(rows: readonly AppReadinessRow[]): HTMLElement {
  const visible = rowsInGroup(rows);
  return h(
    'div',
    { class: 'readiness-table-block' },
    h(
      'section',
      { class: 'panel readiness-table-panel', 'aria-label': 'Apps', 'data-testid': 'readiness-apps' },
      h(
        'div',
        { class: 'readiness-table-scroll' },
        h(
          'div',
          { class: 'readiness-table' },
          h(
            'div',
            { class: 'readiness-head' },
            h('span', null, 'App'),
            h('span', null, 'Breakdown'),
            h('span', { class: 'readiness-num' }, 'Auto'),
            h('span', null, 'Status'),
            h('span', null, 'What it has learned'),
            h('span', null),
          ),
          visible.length === 0
            ? h('p', { class: 'readiness-none' }, 'No app is in this group in the last 7 days.')
            : visible.map(appRow),
        ),
      ),
    ),
    h(
      'p',
      { class: 'readiness-note' },
      'From app names and timing, not model confidence. With browser capture on, the twin also keeps each site\'s host and the shape of its path, never titles, query strings or page content.',
    ),
    h('p', { class: 'readiness-note' }, 'Mail and chat apps always ask. Mail or chat used in a browser is not detected.'),
  );
}

function rowsInGroup(rows: readonly AppReadinessRow[]): readonly AppReadinessRow[] {
  const group = FILTERS.find(item => item.id === listFilter);
  return group ? rows.filter(row => group.statuses.includes(row.status)) : rows;
}

/** One app's row. The whole row is a link to that app's detail. */
function appRow(row: AppReadinessRow): HTMLElement {
  return h(
    'a',
    {
      class: 'readiness-row',
      href: `#/readiness/${encodeURIComponent(row.app)}`,
      'data-testid': 'readiness-row',
      'data-app': row.app,
    },
    h(
      'span',
      { class: 'readiness-app' },
      h('span', { class: 'readiness-mono', 'aria-hidden': 'true' }, monogram(row.app)),
      h(
        'span',
        { class: 'readiness-app-text' },
        h('span', { class: 'readiness-app-name' }, titleCase(row.app)),
        h('span', { class: 'readiness-app-sub' }, `${row.windowClass} · ${row.switches} sw`),
      ),
    ),
    breakdownBar(row, false),
    h('span', { class: 'readiness-num readiness-auto' }, `${row.automatablePct}%`),
    h('span', { class: 'readiness-status' }, statusChip(row.status)),
    h('span', { class: 'readiness-learned-summary' }, learnedSummary(row)),
    chevron(),
  );
}

/** The three shares as one bar, in the same order as the legend. */
function breakdownBar(row: AppReadinessRow, wide: boolean): HTMLElement {
  return h(
    'span',
    {
      class: wide ? 'readiness-bar readiness-bar-wide' : 'readiness-bar',
      role: 'img',
      'aria-label': `Automatable ${row.automatablePct}%, approval ${row.approvalPct}%, not yet ${row.notYetPct}%`,
    },
    h('span', { class: 'readiness-seg readiness-seg-auto', style: { width: `${row.automatablePct}%` } }),
    h('span', { class: 'readiness-seg readiness-seg-ask', style: { width: `${row.approvalPct}%` } }),
    h('span', { class: 'readiness-seg readiness-seg-rest', style: { width: `${row.notYetPct}%` } }),
  );
}

function statusChip(status: AppReadinessStatus): HTMLElement {
  const { label, tone } = STATUS_CHIPS[status];
  return chip(label, tone);
}

function chevron(): SVGElement {
  return svgElement(
    'svg',
    {
      viewBox: '0 0 24 24',
      class: 'readiness-chevron',
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': '2',
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      'aria-hidden': 'true',
    },
    svgElement('path', { d: 'm9 6 6 6-6 6' }),
  );
}

function monogram(app: string): string {
  return app.trim().charAt(0).toUpperCase() || '?';
}

/** The last column of the table: how many routines use the app, and how many of them the person accepted. */
function learnedSummary(row: AppReadinessRow): string {
  if (row.routines === 0) return 'No repeated sequence yet';
  const accepted = row.learned.filter(item => item.status === 'accepted').length;
  return `${plural(row.routines, 'routine')}${accepted > 0 ? ` · ${accepted} accepted` : ''}`;
}

/** One app's detail: its split, what its routines have learned, and the gate of the automation that runs them. */
function detailPage(readiness: AppReadinessView, app: string): HTMLElement {
  const row = readiness.rows.find(candidate => candidate.app === app);
  const crumb = h(
    'nav',
    { class: 'readiness-crumb', 'aria-label': 'Breadcrumb' },
    h('a', { class: 'crumb', href: '#/readiness' }, 'App readiness'),
    h('span', { 'aria-hidden': 'true' }, '/'),
    h('span', null, row ? row.windowClass : 'Not seen in the last 7 days'),
  );
  if (!row) {
    return h(
      'div',
      { class: 'stack readiness-page', 'data-testid': 'readiness-root' },
      crumb,
      h('h1', { class: 'page-title readiness-app-title' }, titleCase(app)),
      h(
        'section',
        { class: 'panel', 'data-testid': 'readiness-missing' },
        emptyState(`No switches from ${titleCase(app)} in the last 7 days.`, 'Go back to App readiness to see the apps that have.'),
      ),
    );
  }
  return h(
    'div',
    { class: 'stack readiness-page', 'data-testid': 'readiness-root' },
    h(
      'header',
      { class: 'readiness-detail-head' },
      h(
        'div',
        { class: 'readiness-detail-title' },
        backLink(),
        h('span', { class: 'readiness-mono readiness-mono-lg', 'aria-hidden': 'true' }, monogram(row.app)),
        h(
          'div',
          { class: 'page-head-text' },
          crumb,
          h('h1', { class: 'page-title readiness-app-title' }, titleCase(row.app)),
          h('p', { class: 'page-meta mono' }, `${row.windowClass} · ${plural(row.switches, 'switch', 'switches')} in the last 7 days`),
        ),
      ),
      breakdownStats(row),
    ),
    reasonStrip(row),
    breakdownBar(row, true),
    h(
      'div',
      { class: 'split readiness-split' },
      learnedPanel(row),
      h('div', { class: 'stack readiness-side' }, gatePanel(row), stylePanel()),
    ),
  );
}

function backLink(): HTMLElement {
  return h(
    'a',
    { class: 'readiness-back', href: '#/readiness', 'aria-label': 'Back to App readiness' },
    svgElement(
      'svg',
      {
        viewBox: '0 0 24 24',
        width: '16',
        height: '16',
        fill: 'none',
        stroke: 'currentColor',
        'stroke-width': '2',
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'aria-hidden': 'true',
      },
      svgElement('path', { d: 'm15 6-6 6 6 6' }),
    ),
  );
}

function breakdownStats(row: AppReadinessRow): HTMLElement {
  return h(
    'dl',
    { class: 'readiness-stats' },
    statItem('Automatable', row.automatablePct, 'readiness-stat-auto'),
    statItem('Approval', row.approvalPct),
    statItem('Not yet', row.notYetPct, 'readiness-stat-rest'),
  );
}

function statItem(label: string, value: number, extra?: string): HTMLElement {
  return h(
    'div',
    { class: extra ? `readiness-stat ${extra}` : 'readiness-stat' },
    h('dt', null, label),
    h('dd', null, `${value}%`),
  );
}

/** The reason strip takes the tint of the chip beside it: teal when part of the app can run on its own, warm when it needs approval. */
function reasonTint(status: AppReadinessStatus): string {
  if (status === 'automatable' || status === 'partly') return 'readiness-reason-teal';
  return status === 'approval' ? 'readiness-reason-warn' : '';
}

function reasonStrip(row: AppReadinessRow): HTMLElement {
  return h(
    'div',
    { class: `readiness-reason ${reasonTint(row.status)}` },
    statusChip(row.status),
    h('span', { class: 'readiness-reason-text' }, row.reason),
    h('span', { class: 'muted small readiness-reason-count' }, routineUseLabel(row.routines)),
  );
}

function learnedPanel(row: AppReadinessRow): HTMLElement {
  return h(
    'section',
    { class: 'panel readiness-panel', 'aria-labelledby': 'readiness-learned-title', 'data-testid': 'readiness-learned' },
    panelHead('What it has learned', plural(row.routines, 'routine'), 'readiness-learned-title'),
    row.learned.length === 0
      ? emptyState(
          'No repeated sequence yet.',
          'This app is not in a routine the twin has seen on a few days. It appears here once it is.',
        )
      : h('ol', { class: 'readiness-learned' }, ...row.learned.map((item, index) => learnedItem(item, index))),
  );
}

function learnedItem(item: AppReadinessRoutineView, index: number): HTMLElement {
  return h(
    'li',
    { class: 'readiness-learned-item', 'data-testid': 'readiness-routine' },
    h('span', { class: 'readiness-index mono' }, String(index + 1).padStart(2, '0')),
    h(
      'span',
      { class: 'readiness-learned-copy' },
      h('span', { class: 'readiness-learned-label' }, titleCaseSequence(item.sequence)),
      h(
        'span',
        { class: 'muted small' },
        `Seen on ${plural(item.days, 'day')} in the last 30 · ${plural(item.switches, 'switch', 'switches')} in the last 7 days`,
      ),
    ),
    h('span', { class: 'readiness-learned-tags' }, kindChip(item.kind), routineStatusChip(item)),
  );
}

function kindChip(kind: AppReadinessRoutineView['kind']): HTMLElement {
  return kind === 'automatable' ? chip('Automatable', 'teal') : chip('Needs approval', 'warn');
}

function routineStatusChip(item: AppReadinessRoutineView): HTMLElement {
  if (item.status === 'dismissed') return chip('Dismissed', 'neutral');
  if (item.status === 'suggested' || item.level === undefined) return chip(item.status === 'accepted' ? 'Accepted' : 'Suggested', 'neutral');
  return chip(`Accepted · ${levelLabel(item.level)}`, levelTone(item.level));
}

/** The promotion gate for the automation that runs this app's routine. Each value is the gate's own. */
function gatePanel(row: AppReadinessRow): HTMLElement {
  const gate = row.gate;
  if (!gate) {
    return h(
      'section',
      { class: 'panel readiness-panel', 'aria-labelledby': 'readiness-gate-title', 'data-testid': 'readiness-gate' },
      panelHead('Promotion gate to L4', undefined, 'readiness-gate-title'),
      emptyState('No automation for this app yet.', 'Accept a routine that uses it in Suggestions to start its gate.'),
    );
  }
  const reached = gate.level >= 4;
  const met = gate.requirements.filter(requirement => requirement.met).length;
  return h(
    'section',
    { class: 'panel readiness-panel', 'aria-labelledby': 'readiness-gate-title', 'data-testid': 'readiness-gate' },
    panelHead('Promotion gate to L4', reached ? undefined : `${met} of ${gate.requirements.length} met`, 'readiness-gate-title'),
    h('p', { class: 'muted small readiness-gate-meta' }, `${gate.automationName} · ${levelLabel(gate.level)}`),
    reached
      ? h('p', { class: 'muted small readiness-gate-meta' }, 'This automation is already at L4.')
      : h('ul', { class: 'readiness-gate-list' }, ...gate.requirements.map(gateRow)),
    h('a', { class: 'crumb readiness-open', href: `#/automations/${encodeURIComponent(gate.automationId)}` }, 'Open this automation'),
  );
}

function gateRow(requirement: GateRequirement): HTMLElement {
  return h(
    'li',
    { class: 'readiness-gate-row', 'data-met': requirement.met ? 'true' : 'false' },
    h(
      'span',
      { class: 'readiness-gate-line' },
      h('span', null, requirement.label),
      h('span', { class: 'mono small readiness-gate-value' }, requirement.value),
    ),
    requirement.progress === undefined ? undefined : progressBar(requirement.progress),
    h(
      'span',
      { class: 'readiness-gate-foot' },
      chip(requirement.met ? 'Met' : 'Open', requirement.met ? 'teal' : 'neutral'),
      requirement.met ? undefined : h('span', { class: 'muted small' }, requirement.reason),
    ),
  );
}

/** Style learning is not built. The block says so and has no control. */
function stylePanel(): HTMLElement {
  return h(
    'section',
    { class: 'panel readiness-panel', 'aria-labelledby': 'readiness-style-title', 'data-testid': 'readiness-style' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title', id: 'readiness-style-title' }, 'Style learning'),
      chip('Not built yet', 'neutral', 'readiness-style-status'),
    ),
    h('p', { class: 'muted small readiness-style-note' }, 'Not part of this build. The twin keeps no style profile.'),
  );
}
