import type { HandoffView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, emptyState, pageHeader } from '../components/ui.js';
import { formatWhen, handoffStateLabel, noticedPerWeek, summarySourceLabel } from '../format.js';
import { handoffTone } from '../labels.js';
import { go, requestRender, state } from '../store.js';

/** Limits on the task tree as this page reads it. The stored tree is already bounded; the page does not rely on that. */
const MAX_TREE_ROWS = 100;
const MAX_TREE_LEVELS = 5;
const MAX_TREE_VISITS = 1_000;
const TREE_INDENT_PX = 20;
const TREE_CHILD_KEYS = ['children', 'subtasks', 'tasks'] as const;
const PREVIEW_CHARS = 80;

/** One line of the task tree: how deep it sits, who owns it, what it is, and its state, as text. */
export interface TreeRow {
  depth: number;
  who: string;
  what: string;
  status: string;
}

interface RoutineGroup {
  automationId: string;
  routineName: string;
  handoffs: HandoffView[];
}

/**
 * Reads the stored task tree into indented rows. The text came from OpenMausBot and was bounded when it was stored, but
 * it is parsed again here as data: anything that is not an object is skipped, and the depth, row and visit counts are
 * capped. Returns undefined when the text does not parse or holds no task, so the caller shows the raw text instead.
 */
export function parseTaskTree(text: string): TreeRow[] | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  const rows: TreeRow[] = [];
  let visits = 0;
  const visit = (value: unknown, depth: number): void => {
    visits++;
    if (visits > MAX_TREE_VISITS || rows.length >= MAX_TREE_ROWS || depth >= MAX_TREE_LEVELS) return;
    if (Array.isArray(value)) {
      for (const item of value) visit(item, depth);
      return;
    }
    if (!value || typeof value !== 'object') return;
    const node = value as Record<string, unknown>;
    rows.push({
      depth,
      who: textOf(node.agent, node.assignee),
      what: textOf(node.title, node.name, node.task, node.id),
      status: textOf(node.state, node.status),
    });
    for (const key of TREE_CHILD_KEYS) visit(node[key], depth + 1);
  };
  visit(parsed, 0);
  return rows.length > 0 ? rows : undefined;
}

/** The first text value among the given fields, trimmed. A number or a flag is shown as its text. */
function textOf(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value.trim().slice(0, 300);
    if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  }
  return '';
}

/** The agent harness page: the lead bot or room, the handoffs by routine, and the selected handoff as a conversation. */
export function harnessView(status: TwinStatus): HTMLElement {
  const handoffs = status.handoffs;
  const target = status.config.openMausBotTarget.trim();
  const selected = handoffs.find(item => item.id === state.selectedHandoff) ?? handoffs[0];
  return h(
    'section',
    { class: 'harness-page', 'data-testid': 'harness-root' },
    pageHeader(
      'Agent harness',
      'Routines handed to OpenMausBot. companyOS keeps each handoff on this device, so the replies survive a restart.',
    ),
    h(
      'div',
      { class: 'harness-layout' },
      leadColumn(target, groupByRoutine(handoffs), selected?.id),
      selected ? conversation(selected) : emptyConversation(target),
    ),
    h(
      'p',
      { class: 'harness-foot muted small', 'data-testid': 'harness-foot' },
      'Replies and approvals happen in OpenMausBot. companyOS shows only what it sent and what came back.',
    ),
  );
}

/** Handoffs grouped by routine. Routines appear in the order of their newest handoff, and each group stays newest first. */
function groupByRoutine(handoffs: readonly HandoffView[]): RoutineGroup[] {
  const groups = new Map<string, RoutineGroup>();
  for (const item of handoffs) {
    const group = groups.get(item.automationId) ?? { automationId: item.automationId, routineName: item.routineName, handoffs: [] };
    group.handoffs.push(item);
    groups.set(item.automationId, group);
  }
  return [...groups.values()];
}

/** The lead bot or room from Settings, labelled as the current setting, then the handoffs grouped by routine. */
function leadColumn(target: string, groups: RoutineGroup[], selectedId: string | undefined): HTMLElement {
  return h(
    'aside',
    { class: 'harness-list', 'aria-label': 'Lead bot and handoffs', 'data-testid': 'harness-list' },
    h(
      'section',
      { class: 'harness-lead' },
      h('span', { class: 'eyebrow' }, 'Lead bot or room'),
      target
        ? h('span', { class: 'harness-lead-name', 'data-testid': 'harness-target' }, target)
        : h('span', { class: 'muted small' }, 'Not set. Choose one in Settings to send handoffs.'),
      target ? h('span', { class: 'muted small' }, 'Current setting. New handoffs go here.') : undefined,
      target ? undefined : button('Open Settings', { onClick: () => go('#/settings') }, 'btn-small'),
    ),
    groups.length === 0
      ? h('p', { class: 'muted small', 'data-testid': 'harness-no-handoffs' }, 'No handoffs yet.')
      : h('div', { class: 'harness-groups' }, ...groups.map(group => routineGroup(group, selectedId))),
  );
}

function routineGroup(group: RoutineGroup, selectedId: string | undefined): HTMLElement {
  return h(
    'section',
    { class: 'harness-group', 'data-testid': 'harness-group' },
    h('h2', { class: 'eyebrow harness-group-title' }, group.routineName),
    ...group.handoffs.map(item => handoffRow(item, item.id === selectedId)),
  );
}

function handoffRow(item: HandoffView, selected: boolean): HTMLElement {
  return h(
    'button',
    {
      type: 'button',
      class: selected ? 'harness-row is-selected' : 'harness-row',
      'data-testid': 'harness-handoff',
      'aria-pressed': String(selected),
      onclick: () => {
        state.selectedHandoff = item.id;
        requestRender();
      },
    },
    h('span', { class: 'harness-row-brief' }, preview(item.brief)),
    h(
      'span',
      { class: 'harness-row-meta' },
      chip(handoffStateLabel(item.state), handoffTone(item.state)),
      h('span', { class: 'mono small muted' }, formatWhen(item.sentAt)),
    ),
  );
}

/** The first line of a brief, shortened for a list. */
function preview(text: string): string {
  const firstLine = text.split('\n').find(line => line.trim())?.trim() ?? '';
  return firstLine.length > PREVIEW_CHARS ? `${firstLine.slice(0, PREVIEW_CHARS - 1)}…` : firstLine;
}

/**
 * The selected handoff as a conversation: what companyOS sent, what came back, and the job it started. The title is the
 * target this handoff was sent to, as it was stored, not the current setting.
 */
function conversation(item: HandoffView): HTMLElement {
  return h(
    'article',
    { class: 'harness-thread', 'data-testid': 'harness-conversation' },
    h(
      'header',
      { class: 'harness-thread-head' },
      h('h2', { class: 'harness-thread-title' }, item.target || 'OpenMausBot'),
      item.target ? h('span', { class: 'mono small muted' }, 'Lead bot or room when sent') : undefined,
    ),
    h('span', { class: 'harness-stamp mono small muted' }, formatWhen(item.sentAt)),
    companyOsMessage(item),
    replyMessage(item),
    item.localFailure ? undefined : jobCard(item),
  );
}

/** What companyOS sent: the routine name, the observed app sequence, the cadence and the brief. */
function companyOsMessage(item: HandoffView): HTMLElement {
  const sequence = item.apps.length > 0 ? item.apps.join(' → ') : 'App sequence not recorded';
  const cadence = item.cadencePerWeek === undefined ? undefined : noticedPerWeek(item.cadencePerWeek);
  return h(
    'div',
    { class: 'harness-bubble harness-bubble-out', 'data-testid': 'harness-sent' },
    h('span', { class: 'harness-bubble-head' }, `From companyOS · ${item.routineName}`),
    h('span', { class: 'harness-bubble-meta mono small' }, [sequence, cadence].filter(Boolean).join(' · ')),
    h('span', { class: 'harness-bubble-body' }, item.brief),
  );
}

/** What came back: OpenMausBot's reply, or companyOS's own message when the handoff never got a reply. */
function replyMessage(item: HandoffView): HTMLElement {
  const sending = item.state === 'sending';
  const body = sending ? 'Waiting for OpenMausBot to reply.' : item.summary || 'No reply text was returned.';
  return h(
    'div',
    {
      class: item.localFailure ? 'harness-bubble harness-bubble-in is-local' : 'harness-bubble harness-bubble-in',
      'data-testid': 'harness-reply',
    },
    h('span', { class: 'harness-bubble-head' }, sending ? 'OpenMausBot reply' : summarySourceLabel(item.localFailure)),
    h('span', { class: 'harness-bubble-body' }, body),
  );
}

/** The job OpenMausBot started: its state, its thread id, and the task tree as an indented list. */
function jobCard(item: HandoffView): HTMLElement {
  return h(
    'section',
    { class: 'harness-job', 'data-testid': 'harness-job', 'aria-label': 'Job' },
    h(
      'div',
      { class: 'harness-job-head' },
      h('span', { class: 'harness-job-title' }, 'Job'),
      h('span', { class: 'harness-job-thread mono small muted', 'data-testid': 'harness-thread' }, threadLabel(item)),
      chip(handoffStateLabel(item.state), handoffTone(item.state), 'harness-state'),
    ),
    treeBody(item),
  );
}

function threadLabel(item: HandoffView): string {
  if (item.threadId) return item.threadId;
  return item.state === 'sending' ? 'Thread pending' : 'No thread id';
}

/** The indented task tree, or the raw text when it does not parse. */
function treeBody(item: HandoffView): Child {
  if (!item.taskTree) {
    return h('p', { class: 'muted small' }, item.state === 'sending' ? 'Waiting for the job to start.' : 'No task tree was returned.');
  }
  const rows = parseTaskTree(item.taskTree);
  if (!rows) return h('pre', { class: 'code-block harness-raw', 'data-testid': 'harness-tree-raw' }, item.taskTree);
  return h('ul', { class: 'harness-tree', 'data-testid': 'harness-tree' }, ...rows.map(treeRow));
}

function treeRow(row: TreeRow): HTMLElement {
  return h(
    'li',
    { class: 'harness-tree-row', style: { paddingLeft: `${row.depth * TREE_INDENT_PX}px` } },
    h('span', { class: `harness-dot harness-dot-${statusTone(row.status)}`, 'aria-hidden': 'true' }),
    row.who ? h('span', { class: 'harness-tree-who' }, row.who) : undefined,
    h('span', { class: 'harness-tree-what' }, row.what || 'Untitled task'),
    row.status ? h('span', { class: 'harness-tree-status mono small muted' }, row.status) : undefined,
  );
}

/** The dot colour for a task's own state. The tree gives that state as free text, so it is matched loosely. */
function statusTone(status: string): 'teal' | 'warn' | 'danger' | 'neutral' {
  if (/complete|done/i.test(status)) return 'teal';
  if (/input|approv|wait|needs/i.test(status)) return 'warn';
  if (/fail|stall|timed|error/i.test(status)) return 'danger';
  return 'neutral';
}

/** Shown until a routine is sent. It says how to send one, and what to set first when the lead bot or room is missing. */
function emptyConversation(target: string): HTMLElement {
  return h(
    'div',
    { class: 'harness-thread harness-thread-empty', 'data-testid': 'harness-empty' },
    emptyState(
      'No handoffs yet.',
      target
        ? 'Open an automation, describe the outcome under Delegate a task tree, and confirm the send. The handoff and the reply appear here.'
        : 'Set a lead bot or room in Settings first. Then open an automation, describe the outcome under Delegate a task tree, and confirm the send.',
      h(
        'div',
        { class: 'actions' },
        target
          ? button('Open automations', { variant: 'primary', onClick: () => go('#/automations') })
          : button('Open Settings', { variant: 'primary', onClick: () => go('#/settings') }),
      ),
    ),
  );
}
