import type { AutomationView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, fact, levelMeter, panel, panelHead, emptyState } from '../components/ui.js';
import { DAY_MS, formatBytes, formatHours, formatRate, percent, plural } from '../format.js';
import { appsSummary, captureTitle, levelLabel } from '../labels.js';
import { call, go, state } from '../store.js';

const HOURS = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const APP_PATTERN_REVIEW_THRESHOLD = 0.8;

export function overviewView(status: TwinStatus): HTMLElement {
  const { stats, automations, suggestions, network } = status;
  const weekAgo = Date.now() - 7 * DAY_MS;
  const callsThisWeek = network.filter(entry => entry.ts >= weekAgo).length;
  return h(
    'div',
    { class: 'stack', 'data-testid': 'view-overview' },
    overviewHero(status),
    stats.routinesLearned === 0 ? learningPanel(status) : undefined,
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
      routinesPanel(automations, suggestions.length),
      h(
        'div',
        { class: 'stack' },
        heatmapPanel(status.activity),
        usagePanel(status.usage),
        devicePanel(status.storageBytes, callsThisWeek),
      ),
    ),
  );
}

function overviewHero(status: TwinStatus): HTMLElement {
  const { suggestions, automations } = status;
  const primary =
    suggestions.length > 0
      ? button(`Review ${plural(suggestions.length, 'suggestion')}`, {
          variant: 'primary',
          onClick: () => go('#/suggestions'),
        })
      : automations.length > 0
        ? button('View automations', { variant: 'primary', onClick: () => go('#/automations') })
        : undefined;
  const summary =
    status.recordedFocusEvents > 0
      ? `${plural(status.recordedFocusEvents, 'app switch')} observed over ${status.stats.observedDays} days. ` +
        'Your data stays encrypted on this device.'
      : 'Learn repeated work patterns from app names and timing. Your activity stays encrypted on this device.';

  return h(
    'header',
    { class: 'overview-hero' },
    h(
      'div',
      { class: 'overview-hero-copy' },
      h('span', { class: 'eyebrow hero-eyebrow' }, 'PRIVATE WORK TWIN'),
      h('h1', { class: 'page-title' }, 'Your twin'),
      h('p', { class: 'page-sub' }, summary),
    ),
    h(
      'div',
      { class: 'overview-hero-side' },
      h(
        'span',
        { class: `capture-pill capture-pill-${status.capture.state}`, 'data-testid': 'overview-capture-state' },
        h('span', { class: `dot dot-${status.capture.state}`, 'aria-hidden': 'true' }),
        captureTitle(status.capture.state),
      ),
      h(
        'div',
        { class: 'actions overview-hero-actions' },
        button('Network ledger', { onClick: () => go('#/ledger') }),
        primary,
      ),
    ),
  );
}

function learningPanel(status: TwinStatus): HTMLElement {
  const paused = status.capture.state === 'paused';
  const unsupported = status.capture.state === 'unsupported';
  const locked = status.capture.state === 'locked';
  const idle = status.capture.state === 'idle';
  const repeatDescription =
    'Use the same short sequence of apps naturally over a few days. Suggestions appear when a pattern repeats.';
  let heading: string;
  let description: string;
  if (unsupported) {
    heading = 'Capture is not available in this session';
    description = status.capture.detail || 'Activity capture is unavailable on this desktop session.';
  } else if (paused) {
    heading = 'Capture is paused';
    description = 'Resume capture when you want the twin to keep learning from app names and timing.';
  } else if (locked) {
    heading = 'Capture will resume when you unlock';
    description = 'Your twin pauses app capture while the screen is locked.';
  } else if (idle) {
    heading = 'Capture is idle while you are away';
    description = 'Capture resumes when you return to your desktop.';
  } else if (status.recordedFocusEvents === 0) {
    heading = 'Your twin is ready to learn';
    description = repeatDescription;
  } else {
    heading = 'Your twin is learning your rhythm';
    description = repeatDescription;
  }
  const captureDetail = unsupported
    ? 'Unavailable'
    : paused
      ? 'Paused'
      : locked
        ? 'Screen locked'
        : idle
          ? 'Waiting for you'
          : 'On this device';

  return panel(
    { testid: 'overview-learning', extra: 'learning-panel', labelledBy: 'learning-title' },
    h(
      'div',
      { class: 'learning-head' },
      h('div', { class: 'learning-copy' },
        h('span', { class: 'eyebrow' }, 'GETTING STARTED'),
        h('h2', { class: 'panel-title', id: 'learning-title' }, heading),
        h('p', { class: 'muted' }, description),
      ),
      paused
        ? button('Resume capture', {
            variant: 'primary',
            disabled: state.pending.has('capture'),
            onClick: () => void call('capture', twin => twin.setPaused(false)),
          })
        : undefined,
    ),
    h(
      'div',
      { class: 'learning-steps' },
      learningStep(
        '01',
        'Capture',
        captureDetail,
        status.capture.state === 'capturing',
      ),
      learningStep('02', 'Repeat', 'Follow your normal app sequence', false),
      learningStep('03', 'Review', 'You decide what becomes an automation', false),
    ),
  );
}

function learningStep(number: string, title: string, detail: string, current: boolean): HTMLElement {
  return h(
    'div',
    { class: current ? 'learning-step is-current' : 'learning-step' },
    h('span', { class: 'learning-number mono' }, number),
    h('span', { class: 'learning-step-copy' },
      h('strong', null, title),
      h('span', { class: 'muted small' }, detail),
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

function routinesPanel(views: readonly AutomationView[], suggestionCount: number): HTMLElement {
  const header: Child = h(
    'div',
    { class: 'table-head' },
    h('span', null, 'Routine'),
    h('span', null, 'How often'),
    h('span', null, 'Apps'),
    h('span', null, 'Autonomy'),
  );
  return panel(
    { testid: 'overview-routines', labelledBy: 'routines-title' },
    panelHead('Your automations', 'Accepted routines and their autonomy', 'routines-title'),
    views.length === 0
      ? suggestionCount > 0
        ? emptyState(
            'Turn a suggestion into a draft.',
            `${plural(suggestionCount, 'routine')} ready for your review. Nothing runs until you raise its level.`,
            button('Review suggestions', { variant: 'primary', onClick: () => go('#/suggestions') }),
          )
        : emptyState(
            'No automations yet.',
            'New patterns appear in Suggestions. Accepting one creates a draft here for you to review.',
          )
      : h('div', { class: 'table-scroll' }, h('div', { class: 'table' }, header, ...views.map(routineRow))),
  );
}

function routineRow(view: AutomationView): HTMLElement {
  const estimate = view.automation.estimate;
  const level = view.state.level;
  return h(
    'div',
    { class: 'table-row' },
    h(
      'a',
      { class: 'row-link', href: `#/automations/${encodeURIComponent(view.automation.id)}` },
      view.automation.name,
    ),
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
      { class: 'heat', role: 'img', 'aria-label': 'App switches by weekday and hour for the past four weeks' },
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

function usagePanel(usage: TwinStatus['usage']): HTMLElement {
  const top = [...usage].sort((a, b) => b.events - a.events).slice(0, 5);
  return panel(
    { testid: 'overview-usage', labelledBy: 'usage-title' },
    panelHead('Apps you use', 'Top apps · switches from the past 7 days, patterns from the past 30', 'usage-title'),
    top.length === 0
      ? emptyState('No app activity yet.', 'Your app usage summary stays on this device.')
      : h(
          'div',
          { class: 'usage-list' },
          ...top.map(app => appLearningRow(app)),
          h(
            'p',
            { class: 'muted small app-learning-note' },
            'This repetition-based learning score is not model confidence or task accuracy. At 80%, a pattern is ready for your review—not blanket app access. Sends and external writes still ask; unattended runs must pass each routine’s safety gate.',
          ),
        ),
  );
}

function appLearningRow(app: TwinStatus['usage'][number]): HTMLElement {
  const score = Math.round(app.learningScore * 100);
  const hasPattern = app.patternCount > 0;
  const strongPattern = app.learningScore >= APP_PATTERN_REVIEW_THRESHOLD;
  const evidence = hasPattern
    ? `${app.patternSupport} observations across ${app.patternDays} ${app.patternDays === 1 ? 'day' : 'days'} · ${plural(app.patternCount, 'pattern')}`
    : 'No repeated workflow pattern yet';
  return h(
    'div',
    { class: 'usage-row app-learning-row' },
    h(
      'div',
      { class: 'usage-meta' },
      h('span', { class: 'usage-app' }, app.app),
      h('span', { class: 'mono small muted' }, plural(app.events, 'switch')),
    ),
    h(
      'div',
      {
        class: `usage-bar app-learning-bar${strongPattern ? ' is-strong' : ''}`,
        role: 'progressbar',
        'aria-label': `${app.app}: ${score}% repetition-based learning signal. This is not model confidence or automation success rate.`,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': score,
      },
      h('span', { style: { width: `${score}%` } }),
    ),
    h(
      'div',
      { class: 'app-learning-foot' },
      h('span', { class: 'mono small app-learning-score' }, `${percent(app.learningScore)} learning`),
      h('span', { class: strongPattern ? 'small teal app-learning-status' : 'small muted app-learning-status' },
        strongPattern ? `Strong · ${evidence}` : evidence,
      ),
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
    h('a', { class: 'manage-data-link', href: '#/settings' }, 'Manage privacy and data in Settings →'),
  );
}
