import { h, type Child, type Props } from '../dom.js';
import { clamp01 } from '../format.js';
import { state } from '../store.js';

const SVG_NAMESPACE = 'http://www.w3.org/2000/svg';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'danger-outline' | 'teal' | 'link';

export interface ButtonOptions {
  variant?: ButtonVariant;
  testid?: string;
  disabled?: boolean;
  onClick?: () => void;
}

export function button(label: string, options: ButtonOptions = {}, extra?: string): HTMLButtonElement {
  const classes = ['btn', `btn-${options.variant ?? 'secondary'}`];
  if (extra) classes.push(extra);
  return h(
    'button',
    {
      type: 'button',
      class: classes.join(' '),
      'data-testid': options.testid,
      disabled: options.disabled,
      onclick: options.onClick,
    },
    label,
  );
}

export type ChipTone = 'neutral' | 'teal' | 'ink' | 'warn' | 'danger' | 'violet';

export function chip(text: string, tone: ChipTone = 'neutral', testid?: string): HTMLSpanElement {
  return h('span', { class: `chip chip-${tone}`, 'data-testid': testid }, text);
}

export function panel(options: { testid?: string; extra?: string; labelledBy?: string } = {}, ...children: Child[]): HTMLElement {
  const classes = ['panel'];
  if (options.extra) classes.push(options.extra);
  return h(
    'section',
    { class: classes.join(' '), 'data-testid': options.testid, 'aria-labelledby': options.labelledBy },
    ...children,
  );
}

export function panelHead(title: string, note?: string, id?: string): HTMLElement {
  return h(
    'header',
    { class: 'panel-head' },
    h('h2', { class: 'panel-title', id }, title),
    note ? h('span', { class: 'panel-note' }, note) : undefined,
  );
}

export function pageHeader(title: string, subtitle?: string, actions?: Child): HTMLElement {
  return h(
    'header',
    { class: 'page-head' },
    h(
      'div',
      { class: 'page-head-text' },
      h('h1', { class: 'page-title' }, title),
      subtitle ? h('p', { class: 'page-sub' }, subtitle) : undefined,
    ),
    actions ? h('div', { class: 'actions' }, actions) : undefined,
  );
}

export function emptyState(title: string, text: string, ...actions: Child[]): HTMLElement {
  return h('div', { class: 'empty' }, h('p', { class: 'empty-title' }, title), h('p', { class: 'muted' }, text), ...actions);
}

export function progressBar(fraction: number, extra: Props = {}): HTMLElement {
  const pct = Math.round(clamp01(fraction) * 100);
  return h(
    'div',
    { class: 'progress', role: 'progressbar', 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': pct, ...extra },
    h('span', { class: 'progress-fill', style: { width: `${pct}%` } }),
  );
}

/** Six segments, filled up to and including the level. */
export function levelMeter(level: number): HTMLElement {
  return h(
    'span',
    { class: 'meter', 'aria-hidden': 'true' },
    ...[0, 1, 2, 3, 4, 5].map(index => h('span', { class: index <= level ? 'meter-seg is-on' : 'meter-seg' })),
  );
}

export function toggleRow(options: {
  testid: string;
  label: string;
  note?: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}): HTMLElement {
  const input = h('input', {
    type: 'checkbox',
    class: 'switch',
    'data-testid': options.testid,
    checked: options.checked,
    disabled: options.disabled,
    onchange: () => options.onChange(input.checked),
  });
  return h(
    'label',
    { class: 'toggle-row' },
    h(
      'span',
      { class: 'toggle-text' },
      h('span', { class: 'toggle-label' }, options.label),
      options.note ? h('span', { class: 'toggle-note' }, options.note) : undefined,
    ),
    input,
  );
}

/**
 * Apps the twin must never record, as removable chips with an input to add one. Each change is saved through onChange.
 * The input is a dirty form while it holds text, so a background refresh does not wipe what the person is typing.
 */
export function exclusionEditor(
  key: string,
  apps: readonly string[],
  testid: string,
  onChange: (next: string[]) => void,
): HTMLElement {
  const input = h('input', {
    type: 'text',
    class: 'input',
    placeholder: 'App name, for example Slack',
    maxlength: 80,
    autocomplete: 'off',
    spellcheck: false,
    'aria-label': 'Add an app to exclude',
    'data-testid': `${testid}-input`,
    oninput: () => {
      state.dirty.add(key);
    },
    onblur: () => {
      if (input.value.trim() === '') state.dirty.delete(key);
    },
    onkeydown: (event: Event) => {
      if (event instanceof KeyboardEvent && event.key === 'Enter') {
        event.preventDefault();
        submit();
      }
    },
  });

  const submit = (): void => {
    const value = input.value.trim().toLowerCase().slice(0, 80);
    state.dirty.delete(key);
    if (!value) return;
    if (apps.some(app => app.toLowerCase() === value)) return;
    onChange([...apps, value]);
  };

  return h(
    'div',
    { class: 'excl', 'data-testid': testid },
    h(
      'div',
      { class: 'excl-list' },
      apps.length === 0 ? h('span', { class: 'muted small' }, 'No apps excluded.') : undefined,
      ...apps.map(app =>
        h(
          'span',
          { class: 'excl-chip' },
          h('span', null, app),
          h(
            'button',
            {
              type: 'button',
              class: 'excl-remove',
              'aria-label': `Remove ${app}`,
              onclick: () => onChange(apps.filter(item => item !== app)),
            },
            '×',
          ),
        ),
      ),
    ),
    h(
      'div',
      { class: 'excl-add' },
      input,
      button('Exclude', { variant: 'ghost', testid: `${testid}-add`, onClick: submit }, 'btn-small'),
    ),
  );
}

function ring(cx: number, className: string): SVGCircleElement {
  const circle = document.createElementNS(SVG_NAMESPACE, 'circle');
  circle.setAttribute('cx', String(cx));
  circle.setAttribute('cy', '14');
  circle.setAttribute('r', '8');
  circle.setAttribute('fill', 'none');
  circle.setAttribute('stroke-width', '2');
  circle.setAttribute('class', className);
  return circle;
}

/** The two overlapping rings from the design. Colours come from CSS classes, so both themes can use it. */
export function logo(size: number): SVGSVGElement {
  const svg = document.createElementNS(SVG_NAMESPACE, 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', '0 0 28 28');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'logo');
  svg.appendChild(ring(11, 'logo-a'));
  svg.appendChild(ring(17, 'logo-b'));
  return svg;
}

export function fact(label: string, value: Child): HTMLElement {
  return h('div', { class: 'fact' }, h('dt', { class: 'muted' }, label), h('dd', null, value));
}
