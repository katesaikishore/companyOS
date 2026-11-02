import type { CaptureChannelState, CaptureHitView, TwinStatus } from '@companyos/twin-core';
import { h, type Child } from '../dom.js';
import { button, chip, emptyState, pageHeader, panel, panelHead } from '../components/ui.js';
import { clock, plural, titleCase } from '../format.js';
import { captureChannelLabel, captureChannelNote } from '../labels.js';
import {
  KIND_LABEL,
  KIND_OPTIONS,
  RANGE_OPTIONS,
  RECALL_COPY,
  RECALL_TEXT_MAX,
  groupByHour,
  searchRequest,
  type HourGroup,
  type RecallKind,
  type RecallRange,
} from '../recall-model.js';
import { act, bridge, pending, requestRender, state } from '../store.js';

/** The search's key. While the words have focus the page is not rebuilt, so typing is not lost. */
const SEARCH_KEY = 'recall:search';
/** Most screen images kept open in memory at once. The oldest is dropped first. */
const FRAME_LIMIT = 8;

/** Counts searches, so a search that finishes after a newer one leaves the newer result. */
let searchTicket = 0;

/**
 * The Recall page: what the twin read on screen or heard, searched by words and grouped by hour. Each screen item can
 * show its image, which is read only when the person asks. Every value comes from the status and the bridge.
 */
export function recallView(status: TwinStatus): HTMLElement {
  return h(
    'div',
    { class: 'recall-view', 'data-testid': 'view-recall' },
    pageHeader(RECALL_COPY.title, RECALL_COPY.note),
    channelsLine(status),
    searchRow(),
    resultsPanel(status),
  );
}

/** Drops the search results and the images read on the page. Called when the page is left, and when the text is deleted. */
export function forgetRecall(): void {
  state.recall.hits = undefined;
  state.recall.open = undefined;
  state.frames.clear();
}

/** Whether screen text or microphone text is on, as a sentence the page can show. */
function channelsLine(status: TwinStatus): HTMLElement {
  const capture = status.capture;
  const channels: Array<{ label: string; channel: CaptureChannelState }> = [
    { label: RECALL_COPY.screenChannel, channel: capture.screenState },
    { label: RECALL_COPY.audioChannel, channel: capture.audioState },
  ];
  return h(
    'section',
    { class: 'recall-channels', 'aria-label': RECALL_COPY.channels, 'data-testid': 'recall-channels' },
    ...channels.map(({ label, channel }) => {
      const note = captureChannelNote(channel);
      return h(
        'div',
        { class: 'recall-channel' },
        h('span', { class: 'recall-channel-name' }, label),
        chip(captureChannelLabel(channel), channel === 'on' ? 'teal' : channel === 'needs_permission' ? 'warn' : 'neutral'),
        note ? h('span', { class: 'muted small' }, note) : undefined,
      );
    }),
    capture.screenState === 'on' ? h('p', { class: 'recall-recording', 'data-testid': 'recall-recording' }, RECALL_COPY.recording) : undefined,
  );
}

/** The words, the kind and the range. Enter or the button runs the search; a change of kind or range runs it at once. */
function searchRow(): HTMLElement {
  const recall = state.recall;
  const input = h('input', {
    type: 'search',
    class: 'input recall-input',
    value: recall.text,
    maxlength: RECALL_TEXT_MAX,
    placeholder: RECALL_COPY.placeholder,
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': RECALL_COPY.searchLabel,
    'data-testid': 'recall-search-input',
    oninput: () => {
      state.recall.text = input.value;
      state.dirty.add(SEARCH_KEY);
    },
    onblur: () => {
      state.dirty.delete(SEARCH_KEY);
    },
    onkeydown: (event: KeyboardEvent) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        void runSearch();
      }
    },
  });

  const kind = h(
    'select',
    {
      class: 'select',
      'data-testid': 'recall-kind',
      'aria-label': RECALL_COPY.kindLabel,
      disabled: pending(SEARCH_KEY),
      onchange: () => {
        state.recall.kind = kind.value as RecallKind;
        void runSearch();
      },
    },
    ...KIND_OPTIONS.map(option => h('option', { value: option.value }, option.label)),
  );
  kind.value = recall.kind;

  const range = h(
    'select',
    {
      class: 'select',
      'data-testid': 'recall-range',
      'aria-label': RECALL_COPY.rangeLabel,
      disabled: pending(SEARCH_KEY),
      onchange: () => {
        state.recall.range = range.value as RecallRange;
        void runSearch();
      },
    },
    ...RANGE_OPTIONS.map(option => h('option', { value: option.value }, option.label)),
  );
  range.value = recall.range;

  return h(
    'section',
    { class: 'recall-search', 'data-testid': 'recall-search' },
    h(
      'div',
      { class: 'recall-search-row' },
      input,
      button(RECALL_COPY.search, {
        variant: 'primary',
        testid: 'recall-search',
        disabled: pending(SEARCH_KEY),
        onClick: () => void runSearch(),
      }, 'btn-small'),
    ),
    h(
      'div',
      { class: 'recall-filters' },
      field(RECALL_COPY.kindLabel, kind),
      field(RECALL_COPY.rangeLabel, range),
    ),
  );
}

function field(label: string, control: HTMLElement): HTMLElement {
  return h('label', { class: 'recall-field' }, h('span', { class: 'recall-field-label muted' }, label), control);
}

/** Runs the search with the words and filters on the page. Only the newest search's result is kept. */
function runSearch(): Promise<void> {
  const recall = state.recall;
  const request = searchRequest(recall, Date.now());
  const ticket = ++searchTicket;
  return act(SEARCH_KEY, async () => {
    state.dirty.delete(SEARCH_KEY);
    const hits = await bridge().searchCapture(request);
    if (ticket !== searchTicket) return;
    recall.hits = hits;
    recall.open = undefined;
  });
}

function resultsPanel(status: TwinStatus): HTMLElement {
  const hits = state.recall.hits;
  const capture = status.capture;
  let body: Child;
  if (hits === undefined) {
    body = emptyState(RECALL_COPY.promptTitle, RECALL_COPY.prompt);
  } else if (hits.length === 0) {
    const anyOn = capture.screenState === 'on' || capture.audioState === 'on';
    const nothingStored = capture.screenCount + capture.audioCount === 0;
    body = !anyOn && nothingStored
      ? emptyState(RECALL_COPY.offTitle, RECALL_COPY.offText)
      : emptyState(RECALL_COPY.noMatchTitle, RECALL_COPY.noMatch);
  } else {
    body = h('div', { class: 'recall-groups', 'data-testid': 'recall-groups' }, ...groupByHour(hits).map(hourBlock));
  }
  return panel(
    { testid: 'recall-results', extra: 'recall-panel', labelledBy: 'recall-results-title' },
    panelHead(RECALL_COPY.results, hits ? plural(hits.length, 'item') : undefined, 'recall-results-title'),
    body,
  );
}

function hourBlock(group: HourGroup): HTMLElement {
  return h(
    'section',
    { class: 'recall-hour', 'data-testid': 'recall-hour' },
    h(
      'h3',
      { class: 'recall-hour-title' },
      h('span', { class: 'mono' }, group.label),
      h('span', { class: 'muted small' }, plural(group.hits.length, 'item')),
    ),
    h('ul', { class: 'recall-list' }, ...group.hits.map(hitRow)),
  );
}

function hitRow(hit: CaptureHitView): HTMLElement {
  const screen = hit.kind === 'screen';
  return h(
    'li',
    { class: 'recall-hit', 'data-testid': 'recall-hit', 'data-kind': hit.kind },
    h(
      'div',
      { class: 'recall-hit-head' },
      h('span', { class: 'mono small' }, clock(hit.ts)),
      chip(KIND_LABEL[hit.kind], 'neutral'),
      hit.app ? h('span', { class: 'muted small recall-app' }, titleCase(hit.app)) : undefined,
    ),
    h('p', { class: 'recall-snippet' }, hit.snippet),
    screen ? imageControl(hit) : undefined,
  );
}

/** The button that shows a screen item's image. The image is read from the store only when it is first shown. */
function imageControl(hit: CaptureHitView): HTMLElement {
  const open = state.recall.open === hit.id;
  const label = open ? RECALL_COPY.hideImage : RECALL_COPY.showImage;
  return h(
    'div',
    { class: 'recall-image' },
    h(
      'button',
      {
        type: 'button',
        class: 'btn btn-ghost btn-small',
        'data-testid': 'recall-image-toggle',
        'aria-expanded': String(open),
        'aria-label': `${label} from ${clock(hit.ts)}`,
        disabled: pending(frameKey(hit.id)),
        onclick: () => void toggleImage(hit.id),
      },
      label,
    ),
    open ? frameBody(hit) : undefined,
  );
}

function frameBody(hit: CaptureHitView): HTMLElement {
  if (!state.frames.has(hit.id)) {
    return h('p', { class: 'muted small recall-frame-note', 'data-testid': 'recall-frame-loading' }, RECALL_COPY.imageLoading);
  }
  const src = state.frames.get(hit.id);
  if (!src) {
    return h('p', { class: 'muted small recall-frame-note', 'data-testid': 'recall-frame-missing' }, RECALL_COPY.imageGone);
  }
  return h('img', {
    class: 'recall-frame',
    src,
    alt: `Screen at ${clock(hit.ts)}`,
    'data-testid': 'recall-frame',
  });
}

function frameKey(id: string): string {
  return `frame:${id}`;
}

/** Shows or hides one image. A new one is read from the store, and the read is kept until the page is left. */
async function toggleImage(id: string): Promise<void> {
  const recall = state.recall;
  if (recall.open === id) {
    recall.open = undefined;
    requestRender();
    return;
  }
  recall.open = id;
  if (state.frames.has(id)) {
    requestRender();
    return;
  }
  await act(frameKey(id), async () => {
    // A failed read is remembered as unavailable, so the page stops waiting, and the error still shows as a notice.
    const src = await bridge().frameImage(id).catch((error: unknown) => {
      rememberFrame(id, null);
      throw error;
    });
    rememberFrame(id, src);
  });
}

/** Keeps an image, and drops the oldest once the cap is passed. The newest is kept last, so the order is the order of reading. */
function rememberFrame(id: string, src: string | null): void {
  state.frames.delete(id);
  state.frames.set(id, src);
  while (state.frames.size > FRAME_LIMIT) {
    const oldest = state.frames.keys().next().value;
    if (oldest === undefined) break;
    state.frames.delete(oldest);
  }
}
