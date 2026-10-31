import type { AutomationView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, emptyState, levelMeter } from '../components/ui.js';
import { formatBytes, formatRate, percent, plural, titleCase, titleCaseSequence } from '../format.js';
import { appsSummary, captureTitle, LEVEL_NAMES, levelLabel } from '../labels.js';
import {
  foundTitle,
  heroLede,
  ladderCounts,
  networkCallsThisWeek,
  RHYTHM_DAYS,
  RHYTHM_HOURS,
  rhythmLevels,
} from '../overview-model.js';
import { call, go, state } from '../store.js';

const APP_PATTERN_STRONG_THRESHOLD = 0.8;

export function overviewView(status: TwinStatus): HTMLElement {
  const { stats, automations, network } = status;
  return h(
    'div',
    { class: 'ov-page', 'data-testid': 'view-overview' },
    overviewTop(status),
    overviewHero(status),
    statsRow(status),
    h(
      'div',
      { class: 'ov-split' },
      h(
        'div',
        { class: 'ov-main' },
        stats.routinesLearned === 0 ? learningPanel(status) : undefined,
        routinesPanel(automations),
        usagePanel(status.usage),
      ),
      h(
        'div',
        { class: 'ov-side' },
        heatmapPanel(status.activity),
        devicePanel(status, networkCallsThisWeek(network, Date.now())),
      ),
    ),
  );
}

function overviewTop(status: TwinStatus): HTMLElement {
  const captured = status.capture.state;
  return h(
    'div',
    { class: 'ov-top' },
    h(
      'nav',
      { class: 'ov-crumb', 'aria-label': 'Breadcrumb' },
      h('span', null, 'Twin'),
      h('span', { 'aria-hidden': 'true' }, '/'),
      h('span', { class: 'ov-crumb-current', 'aria-current': 'page' }, 'Overview'),
    ),
    h(
      'div',
      { class: 'ov-top-pills' },
      h(
        'span',
        { class: captured === 'paused' ? 'ov-pill ov-capture-paused' : 'ov-pill', 'data-testid': 'overview-capture-state' },
        h('span', { class: `dot dot-${captured}`, 'aria-hidden': 'true' }),
        captureTitle(captured),
      ),
      h('span', { class: 'ov-pill mono' }, 'Encrypted · OS keychain'),
    ),
  );
}

function overviewHero(status: TwinStatus): HTMLElement {
  return h(
    'header',
    { class: 'ov-hero' },
    h(
      'div',
      { class: 'ov-hero-copy' },
      h('span', { class: 'ov-eyebrow' }, 'PRIVATE WORK TWIN'),
      h('h1', { class: 'ov-title' }, foundTitle(status.suggestions.length)),
      h('p', { class: 'ov-lede' }, heroLede(status.recordedFocusEvents, status.stats.observedDays)),
      h('div', { class: 'ov-hero-actions' },
        button('Open network ledger', { onClick: () => go('#/ledger') }, 'ov-cta-quiet'),
      ),
    ),
    ladderCard(status.automations),
  );
}

function ladderCard(automations: readonly AutomationView[]): HTMLElement {
  const counts = ladderCounts(automations);
  const most = Math.max(0, ...counts);
  return h(
    'section',
    { class: 'ov-ladder', 'aria-labelledby': 'ladder-title' },
    h(
      'div',
      { class: 'ov-ladder-head' },
      h('h2', { class: 'ov-ladder-title', id: 'ladder-title' }, 'Autonomy ladder'),
      h('span', { class: 'ov-ladder-tag mono' }, 'earned, never assumed'),
    ),
    h('ol', { class: 'ov-ladder-steps' }, ...LEVEL_NAMES.map((name, level) => ladderStep(level, name, counts[level], most))),
  );
}

function ladderStep(level: number, name: string, count: number, most: number): HTMLElement {
  const width = most > 0 ? Math.round((count / most) * 100) : 0;
  return h(
    'li',
    { class: count > 0 ? 'ov-ladder-step is-active' : 'ov-ladder-step' },
    h('span', { class: 'ov-ladder-code mono' }, `L${level}`),
    h(
      'span',
      { class: 'ov-ladder-body' },
      h('span', { class: 'ov-ladder-name' }, name),
      h('span', { class: 'ov-ladder-track', 'aria-hidden': 'true' }, h('span', { class: 'ov-ladder-fill', style: { width: `${width}%` } })),
    ),
    h('span', { class: 'ov-ladder-count mono' }, String(count)),
  );
}

function statsRow(status: TwinStatus): HTMLElement {
  const { stats } = status;
  return h(
    'section',
    { class: 'ov-stats', 'data-testid': 'overview-stats', 'aria-label': 'Summary' },
    statCard({ label: 'Routines learned', value: String(stats.routinesLearned), note: 'Detected and not dismissed, or accepted' }),
    statCard({ label: 'Pending', value: String(stats.waiting), note: 'Suggestions and drafts' }),
    statCard({ label: 'Unattended ready', value: String(stats.unattendedReady), note: 'Level 4 · local and reversible', tag: { text: 'gated' } }),
  );
}

interface StatCard {
  label: string;
  value: string;
  unit?: string;
  note: string;
  tag?: { text: string };
}

function statCard(card: StatCard): HTMLElement {
  return h(
    'div',
    { class: 'ov-stat' },
    h(
      'div',
      { class: 'ov-stat-head' },
      h('span', { class: 'ov-stat-label' }, card.label),
      card.tag ? h('span', { class: 'ov-stat-tag' }, card.tag.text) : undefined,
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

function routinesPanel(views: readonly AutomationView[]): HTMLElement {
  if (views.length === 0) return noAutomationsCard();
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-routines', 'aria-labelledby': 'routines-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'routines-title' }, 'Your automations'),
      h('span', { class: 'ov-card-note' }, 'Accepted routines and their autonomy'),
    ),
    h('div', { class: 'ov-auto-list' }, ...views.map(routineRow)),
  );
}

function noAutomationsCard(): HTMLElement {
  return h(
    'section',
    { class: 'ov-card ov-empty-card', 'data-testid': 'overview-routines', 'aria-labelledby': 'auto-title' },
    h(
      'div',
      { class: 'ov-empty-copy' },
      h('h2', { class: 'ov-card-title', id: 'auto-title' }, 'No automations yet'),
      h('p', { class: 'ov-card-note' }, 'Accepted routines land here as drafts at L2. Raise one to L3 to run it with one click.'),
    ),
    h(
      'div',
      { class: 'ov-empty-actions' },
      h('a', { class: 'ov-link', href: '#/automations' }, 'How levels work →'),
    ),
  );
}

function routineRow(view: AutomationView): HTMLElement {
  const estimate = view.automation.estimate;
  const level = view.state.level;
  return h(
    'div',
    { class: 'ov-auto-row' },
    h(
      'div',
      { class: 'ov-auto-head' },
      h('a', { class: 'ov-auto-name', href: `#/automations/${encodeURIComponent(view.automation.id)}` }, view.automation.name),
      h('span', { class: 'ov-auto-level' }, levelMeter(level), h('span', { class: 'mono small' }, levelLabel(level))),
    ),
    h(
      'div',
      { class: 'ov-auto-meta' },
      h('span', { class: 'ov-auto-apps muted small' }, titleCaseSequence(appsSummary(view))),
      h('span', { class: 'mono small' }, estimate ? `${formatRate(estimate.occurrencesPerWeek)}× / wk` : '—'),
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
    heading = 'Capture is locked';
    description = 'Your twin pauses app capture while the screen is locked. It resumes at unlock unless you paused it.';
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

  return h(
    'section',
    { class: 'ov-card ov-learning', 'data-testid': 'overview-learning', 'aria-labelledby': 'learning-title' },
    h(
      'div',
      { class: 'ov-learning-head' },
      h(
        'div',
        { class: 'ov-learning-copy' },
        h('span', { class: 'eyebrow' }, 'GETTING STARTED'),
        h('h2', { class: 'ov-card-title', id: 'learning-title' }, heading),
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
      { class: 'ov-steps' },
      learningStep('01', 'Capture', captureDetail, status.capture.state === 'capturing'),
      learningStep('02', 'Repeat', 'Follow your normal app sequence', false),
      learningStep('03', 'Decide', 'You decide what becomes an automation', false),
    ),
  );
}

function learningStep(number: string, title: string, detail: string, current: boolean): HTMLElement {
  return h(
    'div',
    { class: current ? 'ov-step is-current' : 'ov-step' },
    h('span', { class: 'ov-step-number mono' }, number),
    h('span', { class: 'ov-step-copy' }, h('strong', null, title), h('span', { class: 'muted small' }, detail)),
  );
}

function usagePanel(usage: TwinStatus['usage']): HTMLElement {
  const top = [...usage].sort((a, b) => b.events - a.events).slice(0, 5);
  return h(
    'section',
    { class: 'ov-card', 'data-testid': 'overview-usage', 'aria-labelledby': 'usage-title' },
    h(
      'div',
      { class: 'ov-card-head' },
      h('h2', { class: 'ov-card-title', id: 'usage-title' }, 'Apps you use'),
      h('span', { class: 'ov-card-note' }, 'Top apps · switches from the past 7 days, patterns from the past 30'),
    ),
    top.length === 0
      ? emptyState('No app activity yet.', 'Your app usage summary stays on this device.')
      : h(
          'div',
          { class: 'ov-usage-list' },
          ...top.map(app => appLearningRow(app)),
          h(
            'p',
            { class: 'muted small ov-usage-note' },
            'This repetition-based learning score is not model confidence or task accuracy. A pattern is offered once it repeats on at least three different days. 80% or more is marked Strong. Mail, chat and other external steps still ask; unattended runs must pass each routine\'s promotion gate.',
          ),
        ),
  );
}

function appLearningRow(app: TwinStatus['usage'][number]): HTMLElement {
  const score = Math.round(app.learningScore * 100);
  const hasPattern = app.patternCount > 0;
  const strongPattern = app.learningScore >= APP_PATTERN_STRONG_THRESHOLD;
  const evidence = hasPattern
    ? `${plural(app.patternSupport, 'observation')} across ${plural(app.patternDays, 'day')} · ${plural(app.patternCount, 'pattern')}`
    : 'No repeated workflow pattern yet';
  return h(
    'div',
    { class: 'ov-usage-row' },
    h(
      'div',
      { class: 'ov-usage-meta' },
      h('span', { class: 'ov-usage-app' }, titleCase(app.app)),
      h('span', { class: 'mono small muted' }, plural(app.events, 'switch', 'switches')),
    ),
    h(
      'div',
      {
        class: strongPattern ? 'ov-usage-bar is-strong' : 'ov-usage-bar',
        role: 'progressbar',
        'aria-label': `${titleCase(app.app)}: ${score}% repetition-based learning signal. This is not model confidence or automation success rate.`,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': score,
      },
      h('span', { style: { width: `${score}%` } }),
    ),
    h(
      'div',
      { class: 'ov-usage-foot' },
      h('span', { class: 'mono small ov-usage-score' }, `${percent(app.learningScore)} learning`),
      h(
        'span',
        { class: strongPattern ? 'small teal ov-usage-status' : 'small muted ov-usage-status' },
        strongPattern ? `Strong · ${evidence}` : evidence,
      ),
    ),
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
      h('span', { class: 'ov-card-note' }, 'App switches by weekday and hour, 08:00 to 18:59, past 4 weeks'),
    ),
    h(
      'div',
      { class: 'ov-rhythm', role: 'img', 'aria-label': 'App switches by weekday and hour, 08:00 to 18:59, past four weeks' },
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
  return h(
    'section',
    { class: 'ov-card ov-device', 'data-testid': 'overview-device', 'aria-labelledby': 'device-title' },
    h('h2', { class: 'ov-card-title', id: 'device-title' }, 'On this device'),
    h(
      'dl',
      { class: 'ov-facts' },
      deviceFact('Twin store', `Encrypted · ${formatBytes(status.storageBytes)}`),
      deviceFact('Key held by', 'This device · OS keychain'),
      deviceFact('Raw events kept', plural(status.retentionDays, 'day')),
      deviceFact('Model and update calls this week', h('a', { href: '#/ledger' }, String(callsThisWeek))),
      deviceFact('Sent outside this device', 'Approved handoffs to OpenMausBot. Model and update requests carry no activity.', true),
    ),
    h('a', { class: 'ov-device-link', href: '#/settings' }, 'Manage privacy and data →'),
  );
}

function deviceFact(label: string, value: Child, wide = false): HTMLElement {
  return h('div', { class: wide ? 'ov-fact is-wide' : 'ov-fact' }, h('dt', null, label), h('dd', null, value));
}
