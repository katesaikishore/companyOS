import type { FileHitView, FileSearchView } from '@companyos/twin-core';
import { h, mount } from './dom.js';
import { bridge, errorText } from './store.js';

/**
 * The search bar, opened with Ctrl+Space. The words go to the app, where the local model reads them as a search and the
 * index of the person's files answers. Enter opens the selected result, Cmd+Enter shows it in Finder, Escape hides the bar.
 */

/** The pause after the last key before searching. A search takes milliseconds, so the bar follows the typing closely. */
const DEBOUNCE_MS = 120;

const view = {
  query: '',
  searching: false,
  result: undefined as FileSearchView | undefined,
  error: undefined as string | undefined,
  selected: 0,
  /** Previews by path, filled in after the results show. */
  previews: {} as Record<string, string>,
};
let timer: ReturnType<typeof setTimeout> | undefined;
let generation = 0;

const input = h('input', {
  class: 'search-input',
  type: 'text',
  placeholder: 'Find a file or photo: “my passport size photo”, “invoices from Acme last month”…',
  'aria-label': 'Search your files',
  'data-testid': 'search-input',
  spellcheck: false,
  oninput: () => {
    view.query = input.value;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Cleared as it fires, so Enter after the results arrive opens the selection instead of searching again.
      timer = undefined;
      void run();
    }, DEBOUNCE_MS);
  },
  onkeydown: (event: KeyboardEvent) => onKey(event),
});

async function run(): Promise<void> {
  const query = view.query.trim();
  const mine = ++generation;
  if (query.length < 2) {
    view.result = undefined;
    view.error = undefined;
    // A search still running belongs to an older query, so its "searching" note goes too.
    view.searching = false;
    render();
    return;
  }
  view.searching = true;
  render();
  try {
    const result = await bridge().searchFiles(query);
    if (mine !== generation) return;
    view.result = result;
    view.error = undefined;
    view.selected = 0;
    void loadPreviews(result, mine);
  } catch (error) {
    if (mine !== generation) return;
    view.error = errorText(error);
  } finally {
    if (mine === generation) {
      view.searching = false;
      render();
    }
  }
}

/** Asks for the previews this search still lacks, and shows them when they come, unless a newer search has started. */
async function loadPreviews(result: FileSearchView, mine: number): Promise<void> {
  const missing = result.hits.map(hit => hit.path).filter(path => !(path in view.previews));
  if (missing.length === 0) return;
  try {
    const previews = await bridge().filePreviews(missing);
    Object.assign(view.previews, previews);
    if (mine === generation) render();
  } catch {
    // A result without a preview still opens.
  }
}

function open(hit: FileHitView | undefined, reveal: boolean): void {
  if (!hit) return;
  void bridge().openIndexedFile(hit.path, reveal);
  void bridge().hideSearch();
}

function onKey(event: KeyboardEvent): void {
  const hits = view.result?.hits ?? [];
  if (event.key === 'Escape') {
    event.preventDefault();
    void bridge().hideSearch();
  } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault();
    if (hits.length === 0) return;
    view.selected = (view.selected + (event.key === 'ArrowDown' ? 1 : hits.length - 1)) % hits.length;
    render();
  } else if (event.key === 'Enter') {
    event.preventDefault();
    if (timer) {
      clearTimeout(timer);
      timer = undefined;
      void run();
      return;
    }
    open(hits[view.selected], event.metaKey);
  }
}

function planLine(result: FileSearchView): string {
  const plan = result.plan;
  const parts = [
    plan.kind === 'image' ? 'photos' : plan.kind === 'document' ? 'documents' : 'any file',
    plan.shape !== 'any' ? `${plan.shape} shape` : '',
    plan.about ? `about “${plan.about}”` : '',
    plan.names.length ? `naming ${plan.names.join(', ')}` : '',
  ].filter(Boolean);
  return `${parts.join(' · ')} — ${result.hits.length} of ${result.indexed} files in ${result.ms} ms${result.meaning ? '' : ', by name and text only'}`;
}

function row(hit: FileHitView, index: number): HTMLElement {
  const selected = index === view.selected;
  return h(
    'li',
    {
      class: `search-hit${selected ? ' is-selected' : ''}`,
      'data-testid': 'search-hit',
      onclick: () => open(hit, false),
      onmouseenter: () => {
        view.selected = index;
        render();
      },
    },
    view.previews[hit.path]
      ? h('img', { class: 'search-preview', src: view.previews[hit.path], alt: '' })
      : h('span', { class: 'search-preview search-icon' }, hit.kind === 'image' ? 'IMG' : hit.kind === 'document' ? 'DOC' : 'FILE'),
    h(
      'span',
      { class: 'search-copy' },
      h('span', { class: 'search-name' }, hit.name),
      h('span', { class: 'search-meta' }, `${hit.folder} · ${new Date(hit.mtime).toLocaleDateString()}`),
      hit.why.length ? h('span', { class: 'search-why' }, hit.why.join(' · ')) : undefined,
    ),
  );
}

function render(): void {
  const root = document.getElementById('search');
  if (!root) return;
  const result = view.result;
  mount(
    root,
    h(
      'div',
      { class: 'search-card', 'data-testid': 'search-root' },
      input,
      view.error
        ? h('p', { class: 'search-note' }, view.error)
        : view.searching
          ? h('p', { class: 'search-note' }, 'Reading your words and looking through your files…')
          : result
            ? h('p', { class: 'search-note' }, planLine(result))
            : h('p', { class: 'search-note' }, 'Enter opens · ⌘Enter shows in Finder · Esc closes'),
      result && result.hits.length > 0 ? h('ul', { class: 'search-hits' }, ...result.hits.map(row)) : undefined,
      result && result.hits.length === 0 && !view.searching ? h('p', { class: 'search-note' }, 'Nothing matched.') : undefined,
    ),
  );
  input.focus();
}

bridge().onSearchOpened(() => {
  // Previews are made again each time the bar opens, so a file that changed since never shows an old picture.
  view.previews = {};
  input.select();
  input.focus();
});
render();
