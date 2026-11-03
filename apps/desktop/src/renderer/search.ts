import type { FileHitView, FileSearchView } from '@companyos/twin-core';
import { h, mount } from './dom.js';
import { bridge, errorText } from './store.js';

/**
 * The search bar, opened with Ctrl+Space. The words go to the app, where the local model reads them as a search and the
 * index of the person's files answers. Enter opens the selected result, Cmd+Enter shows it in Finder, Escape hides the bar.
 */

const DEBOUNCE_MS = 450;

const view = {
  query: '',
  searching: false,
  result: undefined as FileSearchView | undefined,
  error: undefined as string | undefined,
  selected: 0,
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
    timer = setTimeout(() => void run(), DEBOUNCE_MS);
  },
  onkeydown: (event: KeyboardEvent) => onKey(event),
});

async function run(): Promise<void> {
  const query = view.query.trim();
  const mine = ++generation;
  if (query.length < 2) {
    view.result = undefined;
    view.error = undefined;
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
  return `${parts.join(' · ')} — ${result.indexed} files indexed`;
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
    hit.preview ? h('img', { class: 'search-preview', src: hit.preview, alt: '' }) : h('span', { class: 'search-preview search-icon' }, hit.kind === 'document' ? 'DOC' : 'FILE'),
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
  input.select();
  input.focus();
});
render();
