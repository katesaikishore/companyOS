import type { NetworkEntry, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, emptyState, pageHeader } from '../components/ui.js';
import { formatBytes, formatWhen, percent, plural } from '../format.js';
import { captureTitle } from '../labels.js';
import {
  NETWORK_DAYS,
  networkCallsThisWeek,
  networkSummary,
  RHYTHM_DAYS,
  RHYTHM_HOURS,
  rhythmLevels,
  routineChain,
  summaryLine,
} from '../overview-model.js';
import { call, pending } from '../store.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

type Shape = [tag: string, attributes: Record<string, string>];
const LOCK: Shape[] = [
  ['rect', { x: '5', y: '11', width: '14', height: '10', rx: '2' }],
  ['path', { d: 'M8 11V8a4 4 0 0 1 8 0v3' }],
];
const SHIELD: Shape[] = [
  ['path', { d: 'M12 3 4 6v6c0 4.5 3.4 8.3 8 9 4.6-.7 8-4.5 8-9V6l-8-3z' }],
  ['path', { d: 'm9 12 2 2 4-4' }],
];

/** Apps shown as overlapping marks before the rest collapse into a count. */
const MARKS_SHOWN = 3;
/** The height of a full network bar, in pixels. */
const BAR_PX = 56;
/** Shown on the signal, because the number is a repetition score and not a success rate. */
const SIGNAL_NOTE = 'Repetition-based learning score. It is not model confidence or task accuracy.';

export function overviewView(status: TwinStatus): HTMLElement {
  const now = Date.now();
  return h(
    'div',
    { class: 'ov-page', 'data-testid': 'view-overview' },
    overviewHeader(status),
    statsRow(status),
    h(
      'div',
      { class: 'ov-split' },
      h('div', { class: 'ov-main' }, waitingPanel(status), networkPanel(status.network, now)),
      h('div', { class: 'ov-side' }, heatmapPanel(status.activity), devicePanel(status, networkCallsThisWeek(status.network, now))),
    ),
  );
}

function overviewHeader(status: TwinStatus): HTMLElement {
  const captured = status.capture.state;
  const paused = captured === 'paused';
  return pageHeader(
    'Overview',
    summaryLine(status.recordedFocusEvents, status.stats.observedDays),
    [
      h(
        'span',
        { class: paused ? 'ov-pill ov-capture-paused' : 'ov-pill', 'data-testid': 'overview-capture-state' },
        h('span', { class: `dot dot-${captured}`, 'aria-hidden': 'true' }),
        captureTitle(captured),
      ),
      paused
        ? button('Resume capture', {
            variant: 'primary',
            disabled: pending('capture'),
            onClick: () => void call('capture', twin => twin.setPaused(false)),
          })
        : undefined,
      h('span', { class: 'ov-pill' }, outlineIcon(12, LOCK), 'AES-256-GCM · OS keychain'),
    ],
  );
}

function statsRow(status: TwinStatus): HTMLElement {
  const { stats } = status;
  return h(
    'section',
    { class: 'ov-stats', 'data-testid': 'overview-stats', 'aria-label': 'Summary' },
    statCard({ label: 'Routines learned', value: String(stats.routinesLearned), note: 'Detected or accepted' }),
    statCard({
      label: 'Waiting for you',
      value: String(stats.waiting),
      note: 'Suggestions and drafts',
      tag: stats.waiting > 0 ? { text: 'review', warn: true } : undefined,
    }),
    statCard({
      label: 'Unattended ready',
      value: String(stats.unattendedReady),
      note: 'Level 4 · local and reversible',
      tag: stats.unattendedReady === 0 ? { text: 'gated' } : undefined,
    }),
    statCard({
      label: 'Time back',
      value: (stats.minutesBackPerWeek / 60).toFixed(1),
      unit: 'h / wk',
      note: 'From automations at level 3 or above',
      tag: { text: 'estimate' },
    }),
  );
}

interface StatCard {
  label: string;
  value: string;
  unit?: string;
  note: string;
  tag?: { text: string; warn?: boolean };
}

function statCard(card: StatCard): HTMLElement {
  return h(
    'div',
    { class: 'ov-stat' },
    h(
      'div',
      { class: 'ov-stat-head' },
      h('span', { class: 'ov-stat-label' }, card.label),
      card.tag ? h('span', { class: card.tag.warn ? 'ov-stat-tag is-warn' : 'ov-stat-tag' }, card.tag.text) : undefined,
    ),
    h(
      'div',
      { class: 'ov-stat-value-row' },
      h('span', { class: 'ov-stat-value' }, card.value),
      card.unit ? h('span', { class: 'ov-stat-unit' }, card.unit) : undefined,
    ),
    h('span', { class: 'ov-stat-note' }, card.note),
  );
}

function waitingPanel(status: TwinStatus): HTMLElement {
  const routines = status.suggestions;
  return h(
    'section',
    { class: 'ov-card ov-waiting', 'data-testid': 'overview-routines', 'aria-labelledby': 'waiting-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'waiting-title' }, 'Waiting for you'),
      h('span', { class: 'ov-card-note' }, 'Accepting one creates a draft. It runs nothing.'),
      h('a', { class: 'ov-link ov-head-end', href: '#/suggestions' }, 'Review all'),
    ),
    routines.length === 0
      ? waitingEmpty(status)
      : h('ul', { class: 'ov-wait-list' }, ...routines.map(waitingRow)),
  );
}

function waitingEmpty(status: TwinStatus): HTMLElement {
  if (status.stats.routinesLearned > 0) {
    return h(
      'div',
      { class: 'ov-wait-empty' },
      emptyState(
        'Nothing waiting for you.',
        'The twin needs the same sequence on at least three different days to notice a new routine.',
      ),
    );
  }
  const copy = learningCopy(status);
  return h(
    'div',
    { class: 'ov-wait-empty', 'data-testid': 'overview-learning' },
    emptyState(copy.heading, copy.text),
  );
}

/** What the waiting list says before any routine exists. It follows the capture state. */
function learningCopy(status: TwinStatus): { heading: string; text: string } {
  switch (status.capture.state) {
    case 'unsupported':
      return {
        heading: 'Capture is not available in this session',
        text: status.capture.detail || 'Activity capture is unavailable on this desktop session.',
      };
    case 'paused':
      return { heading: 'Capture is paused', text: 'Resume capture when you want the twin to keep learning from app names and timing.' };
    case 'locked':
      return {
        heading: 'Capture is locked',
        text: 'Your twin pauses app capture while the screen is locked. It resumes at unlock unless you paused it.',
      };
    case 'idle':
      return { heading: 'Capture is idle while you are away', text: 'Capture resumes when you return to your desktop.' };
    default:
      return {
        heading: status.recordedFocusEvents === 0 ? 'Your twin is ready to learn' : 'Your twin is learning your rhythm',
        text: 'Use the same short sequence of apps naturally over a few days. Suggestions appear when a pattern repeats.',
      };
  }
}

function waitingRow(item: SuggestionView): HTMLElement {
  const key = `accept:${item.routineId}`;
  const apps = routineChain(item.drafted);
  const when = formatWhen(item.lastSeenAt);
  const meta = apps.length > 0 ? `${apps.join(' → ')} · ${when}` : when;
  const hidden = apps.length - MARKS_SHOWN;
  return h(
    'li',
    { class: 'ov-wait-row' },
    h(
      'span',
      { class: 'ov-app-marks', 'aria-hidden': 'true' },
      ...apps.slice(0, MARKS_SHOWN).map(app => h('span', { class: 'ov-app-mark' }, app.charAt(0))),
      hidden > 0 ? h('span', { class: 'ov-app-more mono' }, `+${hidden}`) : undefined,
    ),
    h(
      'span',
      { class: 'ov-wait-copy' },
      h('span', { class: 'ov-wait-name' }, item.name),
      h('span', { class: 'ov-wait-meta mono' }, meta),
    ),
    h('span', { class: 'ov-signal mono', title: SIGNAL_NOTE }, `${percent(item.score)} learning`),
    button(
      'Accept',
      {
        variant: 'primary',
        disabled: pending(key),
        onClick: () => void call(key, twin => twin.acceptRoutine(item.routineId)),
      },
      'ov-accept',
    ),
  );
}

function networkPanel(network: readonly NetworkEntry[], now: number): HTMLElement {
  const summary = networkSummary(network, now);
  const peak = Math.max(1, ...summary.days.map(day => day.downloads + day.checks));
  const segmentPx = (count: number): number => Math.max(3, Math.round((count / peak) * BAR_PX));
  const stripLabel =
    summary.calls === 0
      ? `No network calls in the past ${NETWORK_DAYS} days.`
      : `${plural(summary.calls, 'network call')} in the past ${NETWORK_DAYS} days: ${plural(summary.downloads, 'model download')} and ${plural(summary.checks, 'update check')}.`;
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-network', 'aria-labelledby': 'net-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'net-title' }, 'Network activity'),
      h('span', { class: 'ov-card-note' }, `Every call, past ${NETWORK_DAYS} days`),
      h('a', { class: 'ov-link ov-head-end', href: '#/ledger' }, 'Open ledger'),
    ),
    h(
      'dl',
      { class: 'ov-figures' },
      figure('Calls', String(summary.calls)),
      figure('Downloaded', formatBytes(summary.bytes)),
      // Fixed, not counted: no request the twin makes carries twin data. The ledger states the same.
      figure('Personal data sent', 'None', true),
    ),
    h(
      'div',
      { class: 'ov-strip', role: 'img', 'aria-label': stripLabel },
      h(
        'div',
        { class: 'ov-strip-bars' },
        ...summary.days.map(day =>
          h(
            'span',
            { class: 'ov-strip-day' },
            day.downloads > 0
              ? h('span', { class: 'ov-strip-seg is-download', style: { height: `${segmentPx(day.downloads)}px` } })
              : undefined,
            day.checks > 0
              ? h('span', { class: 'ov-strip-seg is-check', style: { height: `${segmentPx(day.checks)}px` } })
              : undefined,
          ),
        ),
      ),
      h(
        'div',
        { class: 'ov-strip-axis mono' },
        h('span', null, summary.days[0].label),
        h('span', null, summary.days[Math.floor(NETWORK_DAYS / 2)].label),
        h('span', null, 'Today'),
      ),
    ),
    h(
      'div',
      { class: 'ov-strip-legend' },
      h('span', { class: 'ov-legend-item' }, h('span', { class: 'ov-swatch is-download', 'aria-hidden': 'true' }), 'Model download'),
      h('span', { class: 'ov-legend-item' }, h('span', { class: 'ov-swatch is-check', 'aria-hidden': 'true' }), 'Update check'),
      summary.hosts.length > 0 ? h('span', { class: 'ov-legend-end mono' }, `Hosts: ${summary.hosts.join(', ')}`) : undefined,
    ),
  );
}

function figure(label: string, value: string, accent = false): HTMLElement {
  return h(
    'div',
    { class: 'ov-figure' },
    h('dt', null, label),
    h('dd', { class: accent ? 'ov-figure-value is-accent' : 'ov-figure-value' }, value),
  );
}

function heatmapPanel(activity: number[][]): HTMLElement {
  const rows = rhythmLevels(activity);
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-heatmap', 'aria-labelledby': 'rhythm-title' },
    h(
      'div',
      { class: 'ov-card-intro' },
      h('h2', { class: 'ov-card-title', id: 'rhythm-title' }, 'Your weekly rhythm'),
      h('span', { class: 'ov-card-note' }, 'App switches by weekday and hour, past 4 weeks'),
    ),
    h(
      'div',
      {
        class: 'ov-rhythm',
        role: 'img',
        'aria-label': 'App switches by weekday and hour, 08:00 to 18:59, past four weeks',
      },
      ...RHYTHM_DAYS.map((day, r) =>
        h(
          'div',
          { class: 'ov-rhythm-row' },
          h('span', { class: 'ov-rhythm-day mono' }, day),
          ...rows[r].map((cell, c) =>
            h('span', {
              class: `ov-rhythm-cell ov-cell-${cell.level}`,
              title: `${day} ${RHYTHM_HOURS[c]}:00 · ${plural(cell.count, 'switch', 'switches')}`,
              'aria-hidden': 'true',
            }),
          ),
        ),
      ),
      h(
        'div',
        { class: 'ov-rhythm-axis mono' },
        h('span', { class: 'ov-axis-start' }, '08:00'),
        h('span', { class: 'ov-axis-middle' }, '13:00'),
        h('span', { class: 'ov-axis-end' }, '18:00'),
      ),
    ),
    h(
      'div',
      { class: 'ov-legend' },
      h('span', null, 'Less'),
      ...[0, 1, 2, 3].map(level => h('span', { class: `ov-swatch ov-cell-${level}`, 'aria-hidden': 'true' })),
      h('span', null, 'More'),
      h('span', { class: 'ov-legend-note' }, 'Timing only, no focus scoring'),
    ),
  );
}

function devicePanel(status: TwinStatus, callsThisWeek: number): HTMLElement {
  const handoffs = status.handoffs.length;
  return h(
    'section',
    { class: 'ov-card ov-device', 'data-testid': 'overview-device', 'aria-labelledby': 'device-title' },
    h(
      'div',
      { class: 'ov-card-head ov-device-head' },
      outlineIcon(20, SHIELD, 'ov-device-icon'),
      h('h2', { class: 'ov-card-title', id: 'device-title' }, 'On this device'),
      h('a', { class: 'ov-link ov-head-end', href: '#/settings' }, 'Manage'),
    ),
    h(
      'dl',
      { class: 'ov-facts' },
      deviceFact('Twin store', `Encrypted · ${formatBytes(status.storageBytes)}`),
      deviceFact('Key held by', 'This device · OS keychain'),
      deviceFact('Raw events kept', plural(status.retentionDays, 'day')),
      deviceFact('Network calls this week', h('a', { href: '#/ledger' }, String(callsThisWeek))),
      deviceFact(
        'Sent outside this device',
        handoffs === 0
          ? 'Only model and update requests, which carry no activity.'
          : `${plural(handoffs, 'approved handoff', 'approved handoffs')} to OpenMausBot. Model and update requests carry no activity.`,
        true,
      ),
    ),
  );
}

function deviceFact(label: string, value: Child, wide = false): HTMLElement {
  return h('div', { class: wide ? 'ov-fact is-wide' : 'ov-fact' }, h('dt', null, label), h('dd', null, value));
}

/** A stroked outline icon. It is built in the SVG namespace, which h() does not create. */
function outlineIcon(size: number, shapes: Shape[], extra?: string): SVGSVGElement {
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
