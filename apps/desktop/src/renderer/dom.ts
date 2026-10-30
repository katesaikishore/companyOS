/**
 * Element builder for the renderer. Text goes through text nodes, so data from the device is never parsed as markup.
 * Styles are set through CSSOM (element.style), never through style attributes, which the page's CSP forbids.
 */

export type Child = Node | string | number | false | null | undefined | Child[];

export interface Props {
  class?: string | false | undefined;
  style?: Record<string, string | number>;
  [name: string]: unknown;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props?: Props | null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) applyProps(el, props);
  append(el, children);
  return el;
}

/** Replaces everything inside a container with the given children. */
export function mount(parent: HTMLElement, ...children: Child[]): void {
  parent.replaceChildren();
  append(parent, children);
}

function applyProps(el: HTMLElement, props: Props): void {
  for (const [name, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (name === 'class') {
      el.className = String(value);
    } else if (name === 'style' && typeof value === 'object') {
      for (const [prop, css] of Object.entries(value as Record<string, string | number>)) {
        Reflect.set(el.style, prop, String(css));
      }
    } else if (name.startsWith('on') && typeof value === 'function') {
      el.addEventListener(name.slice(2), value as EventListener);
    } else if (name.includes('-') || name.startsWith('aria')) {
      el.setAttribute(name, value === true ? '' : String(value));
    } else if (name in el) {
      Reflect.set(el, name, value);
    } else {
      el.setAttribute(name, value === true ? '' : String(value));
    }
  }
}

function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(parent, child);
    else if (child instanceof Node) parent.appendChild(child);
    else parent.appendChild(document.createTextNode(String(child)));
  }
}
