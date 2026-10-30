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
import { plural } from '../format.js';
import { levelLabel, levelTone } from '../labels.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';
/** The ring is drawn in a 120 unit box. Its arcs are lengths along a circle of this radius. */
const RING_RADIUS = 50;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const STATUS_CHIPS: Record<AppReadinessStatus, { label: string; tone: ChipTone }> = {
  automatable: { label: 'Automatable', tone: 'teal' },
  partly: { label: 'Partly automatable', tone: 'ink' },
  approval: { label: 'Needs approval', tone: 'warn' },
  not_yet: { label: 'Not yet', tone: 'neutral' },
};

/** The app readiness page: the overview of every app, or one app's detail when the route names it. */
export function readinessView(status: TwinStatus, app?: string): HTMLElement {
  return app === undefined ? listPage(status.readiness) : detailPage(status.readiness, app);
}

/**
 * The sentence under the banner, chosen by the overall automatable share in whole percent. The bands are design
 * thresholds, not sourced standards. The tests pin each boundary.
 */
export function readinessSentence(automatablePct: number): string {
  if (automatablePct < 20) return 'Little of your repeated app work could run on its own yet.';
  if (automatablePct < 40) return 'About a third of your repeated app work could run on its own.';
  if (automatablePct < 60) return 'About half of your repeated app work could run on its own.';
  return 'Most of your repeated app work could run on its own.';
}

function listPage(readiness: AppReadinessView): HTMLElement {
  const body: Child = readiness.switches === 0 ? emptyPanel() : [banner(readiness), appTable(readiness.rows)];
  return h(
    'div',
    { class: 'stack readiness-page', 'data-testid': 'readiness-root' },
    pageHeader('App readiness', "How much of each app's repeated work could run on its own · past 7 days"),
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

/** The dark summary: the automatable share as a ring, the sentence for it, and the three groups as legend chips. */
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

/** The app table. Each row opens that app's detail. The note under it says what the figures rest on. */
function appTable(rows: readonly AppReadinessRow[]): HTMLElement {
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
          ...rows.map(appRow),
        ),
      ),
    ),
    h('p', { class: 'readiness-note' }, 'From app names and timing, not model confidence. Mail and chat steps always ask.'),
  );
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
        h('span', { class: 'readiness-app-name' }, row.app),
        h('span', { class: 'readiness-app-sub' }, `${row.windowClass} · ${plural(row.switches, 'switch', 'switches')}`),
      ),
    ),
    breakdownBar(row, false),
    h('span', { class: 'readiness-num readiness-auto' }, `${row.automatablePct}%`),
    h('span', null, statusChip(row.status)),
    h('span', { class: 'readiness-learned-summary small' }, learnedSummary(row)),
    h('span', { class: 'readiness-chevron', 'aria-hidden': 'true' }, '›'),
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
      h('h1', { class: 'page-title readiness-app-title' }, app),
      h(
        'section',
        { class: 'panel', 'data-testid': 'readiness-missing' },
        emptyState(`No switches from ${app} in the last 7 days.`, 'Go back to App readiness to see the apps that have.'),
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
        h('span', { class: 'readiness-mono readiness-mono-lg', 'aria-hidden': 'true' }, monogram(row.app)),
        h(
          'div',
          { class: 'page-head-text' },
          crumb,
          h('h1', { class: 'page-title readiness-app-title' }, row.app),
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
      h('div', { class: 'stack' }, gatePanel(row), stylePanel()),
    ),
  );
}

function breakdownStats(row: AppReadinessRow): HTMLElement {
  return h(
    'dl',
    { class: 'readiness-stats' },
    statItem('Automatable', row.automatablePct, 'readiness-stat-auto'),
    statItem('Approval', row.approvalPct),
    statItem('Not yet', row.notYetPct),
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

function reasonStrip(row: AppReadinessRow): HTMLElement {
  return h(
    'div',
    { class: 'readiness-reason' },
    statusChip(row.status),
    h('span', { class: 'readiness-reason-text' }, row.reason),
    h('span', { class: 'muted small readiness-reason-count' }, `${plural(row.routines, 'routine')} use this app`),
  );
}

function learnedPanel(row: AppReadinessRow): HTMLElement {
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'readiness-learned-title', 'data-testid': 'readiness-learned' },
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
      h('span', { class: 'readiness-learned-label' }, item.sequence),
      h('span', { class: 'muted small' }, `Seen on ${plural(item.days, 'day')} · ${plural(item.switches, 'switch', 'switches')} in the last 7 days`),
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
      { class: 'panel', 'aria-labelledby': 'readiness-gate-title', 'data-testid': 'readiness-gate' },
      panelHead('Promotion gate to L4', undefined, 'readiness-gate-title'),
      emptyState('No automation for this app yet.', 'Accept a routine that uses it in Suggestions to start its gate.'),
    );
  }
  const met = gate.requirements.filter(requirement => requirement.met).length;
  return h(
    'section',
    { class: 'panel', 'aria-labelledby': 'readiness-gate-title', 'data-testid': 'readiness-gate' },
    panelHead('Promotion gate to L4', `${met} of ${gate.requirements.length} met`, 'readiness-gate-title'),
    h('p', { class: 'muted small' }, `${gate.automationName} · ${levelLabel(gate.level)}`),
    gate.level >= 4 ? h('p', { class: 'muted small' }, 'This automation is already at L4.') : undefined,
    h('ul', { class: 'readiness-gate-list' }, ...gate.requirements.map(gateRow)),
    h('a', { class: 'crumb', href: `#/automations/${encodeURIComponent(gate.automationId)}` }, 'Open this automation'),
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
    { class: 'panel', 'aria-labelledby': 'readiness-style-title', 'data-testid': 'readiness-style' },
    h(
      'header',
      { class: 'panel-head' },
      h('h2', { class: 'panel-title', id: 'readiness-style-title' }, 'Style learning'),
      chip('Not built yet', 'neutral', 'readiness-style-status'),
    ),
    h('p', { class: 'muted small' }, 'Not part of this build. The twin keeps no style profile.'),
  );
}
