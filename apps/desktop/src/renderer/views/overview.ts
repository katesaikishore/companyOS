import type { NetworkEntry, SuggestionView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { AUTOMATE, CHEVRON, LOCK, outlineIcon, type Shape, SHIELD, SUGGEST } from '../components/shell.js';
import { button, emptyState, pageHeader } from '../components/ui.js';
import { formatBytes, formatWhen, percent, plural } from '../format.js';
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
import { tasksNote } from '../review-model.js';
import { call, pending } from '../store.js';
import { appColour, type Tone } from '../tones.js';

/** Apps shown as overlapping marks before the rest collapse into a count. */
const MARKS_SHOWN = 3;
/** The height of a full network bar, in pixels. */
const BAR_PX = 56;
/** Shown on the signal, because the number is a repetition score and not a success rate. */
const SIGNAL_NOTE = 'Repetition-based learning score. It is not model confidence or task accuracy.';

const PULSE: Shape[] = [['path', { d: 'M3 12h4l3-7 4 14 3-7h4' }]];
const INBOX: Shape[] = [
  ['path', { d: 'M3 13h5l1.5 3h5l1.5-3h5' }],
  ['path', { d: 'M5.5 5h13L21 13v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5z' }],
];
const BOLT: Shape[] = [['path', { d: 'M13 3 5 14h6l-1 7 8-11h-6z' }]];
const CLOCK: Shape[] = [
  ['circle', { cx: '12', cy: '12', r: '9' }],
  ['path', { d: 'M12 7v5l3 2' }],
];

const TASKS: Shape[] = [
  ['path', { d: 'M10 6h10' }],
  ['path', { d: 'M10 12h10' }],
  ['path', { d: 'M10 18h10' }],
  ['path', { d: 'M4 6l1.6 1.6L8 5' }],
  ['path', { d: 'M4 12l1.6 1.6L8 11' }],
  ['path', { d: 'M4 18l1.6 1.6L8 17' }],
];

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
      h('div', { class: 'ov-main' }, inboxTiles(status), waitingPanel(status), networkPanel(status.network, now)),
      h('div', { class: 'ov-side' }, heatmapPanel(status.activity), devicePanel(status, networkCallsThisWeek(status.network, now))),
    ),
  );
}

function overviewHeader(status: TwinStatus): HTMLElement {
  return pageHeader(
    'Overview',
    summaryLine(status.recordedFocusEvents, status.stats.observedDays),
    h('span', { class: 'ov-pill' }, outlineIcon(12, LOCK), 'SQLCipher · OS keychain'),
  );
}

interface InboxTile {
  href: string;
  icon: Shape[];
  tone: Tone;
  title: string;
  count: number;
  note: string;
}

/** Suggestions and automations, each a link to its page. A count above zero shows as a badge. */
function inboxTiles(status: TwinStatus): HTMLElement {
  const suggestions = status.suggestions.length;
  const automations = status.automations.length;
  return h(
    'div',
    { class: 'ov-inbox' },
    inboxTile({
      href: '#/suggestions',
      icon: SUGGEST,
      tone: 'orange',
      title: 'Suggestions',
      count: suggestions,
      note: suggestions > 0 ? plural(suggestions, 'new routine to review', 'new routines to review') : 'Nothing new',
    }),
    inboxTile({
      href: '#/automations',
      icon: AUTOMATE,
      tone: 'green',
      title: 'Automations',
      count: automations,
      note:
        automations > 0
          ? plural(automations, 'automation needs your attention', 'automations need your attention')
          : 'None yet · accepted routines land here',
    }),
    tasksTile(status),
  );
}

/** Today's tasks, when the day has any. The tile opens the review, where the person confirms, renames, merges or splits them. */
function tasksTile(status: TwinStatus): HTMLElement | undefined {
  const { tasks } = status.tasks;
  if (tasks.length === 0) return undefined;
  // The badge counts what still waits for the person, as the other tiles do, so it clears once every task is confirmed.
  const open = tasks.filter(task => !task.confirmed).length;
  return inboxTile({
    href: '#/review',
    icon: TASKS,
    tone: 'blue',
    title: 'Review today',
    count: open,
    note: tasksNote(tasks),
  });
}

function inboxTile(tile: InboxTile): HTMLElement {
  return h(
    'a',
    { class: `ov-tile tone-${tile.tone}`, href: tile.href },
    h(
      'span',
      { class: 'ov-tile-icon' },
      outlineIcon(18, tile.icon),
      tile.count > 0 ? h('span', { class: 'ov-tile-badge mono' }, String(tile.count)) : undefined,
    ),
    h(
      'span',
      { class: 'ov-tile-copy' },
      h('span', { class: 'ov-tile-title' }, tile.title),
      h('span', { class: 'ov-tile-note' }, tile.note),
    ),
    outlineIcon(16, CHEVRON, 'ov-tile-chevron'),
  );
}

function statsRow(status: TwinStatus): HTMLElement {
  const { stats } = status;
  return h(
    'section',
    { class: 'ov-stats', 'data-testid': 'overview-stats', 'aria-label': 'Summary' },
    statCard({
      label: 'Routines learned',
      value: String(stats.routinesLearned),
      note: 'Detected or accepted',
      icon: PULSE,
      tone: 'blue',
    }),
    statCard({
      label: 'Waiting for you',
      icon: INBOX,
      tone: 'orange',
      value: String(stats.waiting),
      note: 'Suggestions and drafts',
      tag: stats.waiting > 0 ? { text: 'review', warn: true } : undefined,
    }),
    statCard({
      label: 'Unattended ready',
      icon: BOLT,
      tone: 'green',
      value: String(stats.unattendedReady),
      note: 'Level 4 · local and reversible',
      tag: stats.unattendedReady === 0 ? { text: 'gated' } : undefined,
    }),
    statCard({
      label: 'Time back',
      icon: CLOCK,
      tone: 'purple',
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
  icon: Shape[];
  tone: Tone;
  tag?: { text: string; warn?: boolean };
}

function statCard(card: StatCard): HTMLElement {
  return h(
    'div',
    { class: `ov-stat tone-${card.tone}` },
    h(
      'div',
      { class: 'ov-stat-head' },
      h('span', { class: 'ov-stat-icon' }, outlineIcon(16, card.icon)),
      card.tag ? h('span', { class: card.tag.warn ? 'ov-stat-tag is-warn' : 'ov-stat-tag' }, card.tag.text) : undefined,
    ),
    h('span', { class: 'ov-stat-label' }, card.label),
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
      ...apps.slice(0, MARKS_SHOWN).map(app => h('span', { class: `ov-app-mark app-${appColour(app)}` }, app.charAt(0))),
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
      summary.hosts.length > 0 ? h('span', { class: 'ov-legend-end mono' }, `${summary.hosts.join(', ')} only`) : undefined,
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
        h('span', { class: 'ov-axis-end' }, '18'),
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
      deviceFact('Key held by', 'You · OS keychain'),
      deviceFact('Raw events kept', plural(status.retentionDays, 'day')),
      deviceFact('Network calls this week', h('a', { href: '#/ledger' }, String(callsThisWeek))),
      deviceFact(
        'Sent outside this device',
        'Only model and update requests, which carry no activity.',
        true,
      ),
    ),
  );
}

function deviceFact(label: string, value: Child, wide = false): HTMLElement {
  return h('div', { class: wide ? 'ov-fact is-wide' : 'ov-fact' }, h('dt', null, label), h('dd', null, value));
}
