import { h } from '../dom.js';
import { button, panel, panelHead } from '../components/ui.js';
import { draftReady, parseMenuPath, type MenuAutomationDraft } from '../menu-automation-model.js';
import { call, go, pending, state } from '../store.js';

const KEY = 'menu-automation';
const NOTE =
  'Brings the app forward, then chooses the menu path. A menu bar item and one item in it go through the agent-desktop program, under the automation’s own named cursor, and the app needs an open window. A path with a submenu is pressed by macOS without opening a menu. It starts as a draft, and every run asks before the menu is chosen.';

const draft: MenuAutomationDraft = { name: '', app: '', path: '' };

/** A form that makes a draft automation by hand: one app and one menu path, such as "View > Clean Up By > Name". */
export function menuAutomationPanel(): HTMLElement {
  let createButton: HTMLButtonElement | undefined;
  const update = (field: keyof MenuAutomationDraft) => (event: Event) => {
    draft[field] = (event.currentTarget as HTMLInputElement).value;
    // Unsaved only while a field holds text, so emptied fields let the page redraw again, as the other forms do.
    if (Object.values(draft).some(value => value.trim() !== '')) state.dirty.add(KEY);
    else state.dirty.delete(KEY);
    if (createButton) createButton.disabled = !draftReady(draft) || pending(KEY);
  };
  const field = (label: string, name: keyof MenuAutomationDraft, placeholder: string, maxlength: number) =>
    h(
      'label',
      { class: 'field' },
      h('span', { class: 'field-label' }, label),
      h('input', {
        type: 'text',
        class: 'input',
        value: draft[name],
        placeholder,
        maxlength,
        autocomplete: 'off',
        spellcheck: false,
        'data-testid': `menu-automation-${name}`,
        oninput: update(name),
      }),
    );
  createButton = button(
    'Create draft',
    {
      variant: 'primary',
      testid: 'menu-automation-create',
      disabled: !draftReady(draft) || pending(KEY),
      onClick: () =>
        void call(KEY, async twin => {
          const view = await twin.createMenuAutomation({
            name: draft.name.trim(),
            app: draft.app.trim(),
            menu: parseMenuPath(draft.path),
          });
          draft.name = '';
          draft.app = '';
          draft.path = '';
          state.dirty.delete(KEY);
          go(`#/automations/${encodeURIComponent(view.automation.id)}`);
        }),
    },
  );
  return panel(
    { testid: 'menu-automation-panel', extra: 'menu-automation' },
    panelHead('New menu automation', NOTE),
    h(
      'div',
      { class: 'menu-automation-fields' },
      field('Name', 'name', 'Arrange the Desktop', 80),
      field('App', 'app', 'Finder', 100),
      field('Menu path', 'path', 'View > Clean Up By > Name', 330),
    ),
    h('div', { class: 'actions' }, createButton),
  );
}
