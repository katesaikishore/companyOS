import type { NetworkEntry, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { LOCK, outlineIcon, SHIELD } from '../components/shell.js';
import { emptyState, pageHeader } from '../components/ui.js';
import { formatBytes, plural } from '../format.js';
import {
  NETWORK_DAYS,
  networkCallsThisWeek,
  networkSummary,
  RHYTHM_DAYS,
  RHYTHM_HOURS,
  rhythmLevels,
  summaryLine,
} from '../overview-model.js';
import { taskRow } from './tasks.js';

/** Apps shown as overlapping marks before the rest collapse into a count. */
const MARKS_SHOWN = 3;
/** The height of a full network bar, in pixels. */
const BAR_PX = 56;


export function overviewView(status: TwinStatus): HTMLElement {
  const now = Date.now();
  return h(
    'div',
    { class: 'ov-page', 'data-testid': 'view-overview' },
    overviewHeader(status),
    h(
      'div',
      { class: 'ov-split' },
      h(
        'div',
        { class: 'ov-main' },
        assignedPanel(status),
        taskRunsPanel(status.taskRuns ?? []),
        networkPanel(status.network, now),
      ),
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

/** The top few tasks Recall has assigned. The full ranking is on the Tasks page. */
function assignedPanel(status: TwinStatus): HTMLElement {
  const tasks = status.assignedTasks ?? [];
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-assigned', 'aria-labelledby': 'assigned-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'assigned-title' }, 'Assigned from Recall'),
      h('span', { class: 'ov-card-note' }, 'Ranked by what Recall saw, past 7 days'),
      h('a', { class: 'ov-link ov-head-end', href: '#/tasks' }, 'All tasks'),
    ),
    tasks.length === 0
      ? h('div', { class: 'ov-wait-empty' }, emptyState('No tasks assigned yet.', 'Recall assigns a task once it has seen one of your automations’ apps.'))
      : h('ul', { class: 'ov-wait-list' }, ...tasks.slice(0, MARKS_SHOWN).map((task, index) => taskRow(task, index + 1))),
  );
}

/** Completed and failed automation runs per day, over two weeks. Each run is registered here, whatever started it. */
const TASK_RUN_BAR_PX = 56;
function taskRunsPanel(runs: readonly number[]): HTMLElement {
  const total = runs.reduce((sum, count) => sum + count, 0);
  const peak = Math.max(1, ...runs);
  const days = runs.length;
  const label = (index: number): string => {
    const date = new Date(Date.now() - (days - 1 - index) * 86_400_000);
    return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  };
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-task-runs', 'aria-labelledby': 'task-runs-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'task-runs-title' }, 'Task runs'),
      h('span', { class: 'ov-card-note' }, `Automation runs, past ${days} days`),
    ),
    h(
      'dl',
      { class: 'ov-figures' },
      figure('Runs', String(total)),
      figure('Busiest day', String(Math.max(0, ...runs))),
    ),
    h(
      'div',
      { class: 'ov-strip', role: 'img', 'aria-label': `${plural(total, 'task run')} in the past ${days} days.` },
      h(
        'div',
        { class: 'ov-strip-bars' },
        ...runs.map(count =>
          h(
            'span',
            { class: 'ov-strip-day' },
            count > 0
              ? h('span', { class: 'ov-strip-seg is-run', style: { height: `${Math.max(3, Math.round((count / peak) * TASK_RUN_BAR_PX))}px` } })
              : undefined,
          ),
        ),
      ),
      h(
        'div',
        { class: 'ov-strip-axis mono' },
        h('span', null, label(0)),
        h('span', null, label(Math.floor(days / 2))),
        h('span', null, 'Today'),
      ),
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
      // Fixed, not counted: model and update requests carry no twin data. Google calls, when Gmail is connected, send the
      // sign-in token and the mail search, and the ledger says so.
      figure('Personal data sent', 'None in model calls', true),
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
