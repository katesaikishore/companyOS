import type { AutomationView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, fact, levelMeter, panel, panelHead, pageHeader, emptyState } from '../components/ui.js';
import { DAY_MS, formatBytes, formatHours, formatRate, plural } from '../format.js';
import { appsSummary, levelLabel } from '../labels.js';
import { confirmDeleteAll, go } from '../store.js';

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function overviewView(status: TwinStatus): HTMLElement {
  const { stats, automations, suggestions, network } = status;
  const weekAgo = Date.now() - 7 * DAY_MS;
  const callsThisWeek = network.filter(entry => entry.ts >= weekAgo).length;
  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-overview' },
    pageHeader(
      'Your twin',
      `Built on this device from ${stats.observedDays} days of activity. Raw data has not left this device.`,
      [
        button('Network ledger', { onClick: () => go('#/ledger') }),
        button(`Review ${plural(suggestions.length, 'suggestion')}`, {
          variant: 'primary',
          onClick: () => go('#/suggestions'),
        }),
      ],
    ),
    h(
      'section',
      { class: 'stat-grid', 'data-testid': 'overview-stats', 'aria-label': 'Summary' },
      statCard('Routines learned', String(stats.routinesLearned), 'Detected or accepted'),
      statCard('Waiting for you', String(stats.waiting), 'Suggestions and drafts'),
      statCard('Unattended ready', String(stats.unattendedReady), 'Level 4 · local and reversible'),
      statCard('Time back', formatHours(stats.minutesBackPerWeek), 'Estimate per week, from automations you kept'),
    ),
    h(
      'div',
      { class: 'split' },
      routinesPanel(automations),
      h('div', { class: 'stack' }, heatmapPanel(status.activity), devicePanel(status.storageBytes, callsThisWeek)),
    ),
  );
}

function statCard(label: string, value: string, note: string): HTMLElement {
  return h(
    'div',
    { class: 'card stat' },
    h('span', { class: 'stat-label' }, label),
    h('span', { class: 'stat-value' }, value),
    h('span', { class: 'stat-note' }, note),
  );
}

function routinesPanel(views: readonly AutomationView[]): HTMLElement {
  const header: Child = h(
    'div',
    { class: 'table-head' },
    h('span', null, 'Routine'),
    h('span', null, 'How often'),
    h('span', null, 'Apps'),
    h('span', null, 'Autonomy'),
  );
  return panel({ testid: 'overview-routines', labelledBy: 'routines-title' }, panelHead('Routines the twin has learned', 'Mined from structure, not content', 'routines-title'), views.length === 0
    ? emptyState('No routines accepted yet.', 'Accepted routines appear here with how often they run and how much autonomy they have.')
    : h('div', { class: 'table-scroll' }, h('div', { class: 'table' }, header, ...views.map(routineRow))));
}

function routineRow(view: AutomationView): HTMLElement {
  const estimate = view.automation.estimate;
  const level = view.state.level;
  return h(
    'div',
    { class: 'table-row' },
    h('a', { class: 'row-link', href: `#/automations/${encodeURIComponent(view.automation.id)}` }, view.automation.name),
    h('span', { class: 'mono small' }, estimate ? `${formatRate(estimate.occurrencesPerWeek)}× / wk` : '—'),
    h('span', { class: 'muted small' }, appsSummary(view)),
    h('span', { class: 'autonomy' }, levelMeter(level), h('span', { class: 'mono small' }, levelLabel(level))),
  );
}

const DAY_LABELS: readonly string[] = DAYS;

/** Intensity buckets for the timing grid: 0 is empty, 3 is the busiest cell shown. */
function heatLevels(activity: readonly (readonly number[])[]): { level: number; count: number }[][] {
  const counts = DAY_LABELS.map((_, day) => HOURS.map(hour => activity[day]?.[hour] ?? 0));
  const max = Math.max(0, ...counts.flat());
  return counts.map(row =>
    row.map(count => {
      if (count <= 0 || max === 0) return { level: 0, count };
      const ratio = count / max;
      if (ratio <= 0.34) return { level: 1, count };
      if (ratio <= 0.67) return { level: 2, count };
      return { level: 3, count };
    }),
  );
}

function heatmapPanel(activity: number[][]): HTMLElement {
  const rows = heatLevels(activity);
  return panel({ testid: 'overview-heatmap', labelledBy: 'rhythm-title' },
    h(
      'div',
      { class: 'panel-intro' },
      h('h2', { class: 'panel-title', id: 'rhythm-title' }, 'When your routines happen'),
      h('span', { class: 'panel-note' }, 'Patterns for timing suggestions. No focus or idle scoring.'),
    ),
    h(
      'div',
      { class: 'heat' },
      ...DAY_LABELS.map((day, r) =>
        h(
          'div',
          { class: 'heat-row' },
          h('span', { class: 'heat-day mono' }, day),
          ...rows[r].map((cell, c) =>
            h('span', {
              class: `heat-cell heat-${cell.level}`,
              title: `${day} ${HOURS[c]}:00 · ${cell.count} focus switches`,
              'aria-hidden': 'true',
            }),
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'heat-axis mono small' },
      h('span', null, '08:00'),
      h('span', null, '13:00'),
      h('span', null, '18:00'),
    ),
  );
}

function devicePanel(storageBytes: number, callsThisWeek: number): HTMLElement {
  return panel({ testid: 'overview-device', labelledBy: 'device-title' },
    h('h2', { class: 'panel-title', id: 'device-title' }, 'On this device'),
    h(
      'dl',
      { class: 'facts' },
      fact('Twin store', `Encrypted · ${formatBytes(storageBytes)}`),
      fact('Key held by', 'You · OS keychain'),
      fact('Raw events kept', '90 days'),
      fact(
        'Network calls this week',
        h('a', { href: '#/ledger' }, String(callsThisWeek)),
      ),
      fact('Shared with employer', 'Nothing (personal mode)'),
    ),
    button('Delete my twin', { variant: 'danger-outline', testid: 'overview-delete', onClick: confirmDeleteAll }, 'btn-start'),
  );
}
