import { h } from '../dom.js';
import { button, panel, panelHead } from '../components/ui.js';
import { draftReady, parseMenuPath, type MenuAutomationDraft } from '../menu-automation-model.js';
import { call, go, pending, state } from '../store.js';

const KEY = 'menu-automation';
const NOTE =
  'Brings the app forward, then chooses a menu bar item and one item in its menu through the agent-desktop program, under its own named cursor. Submenus are not supported yet. It starts as a draft, and every run asks before the menu is chosen. The app needs an open window.';

const draft: MenuAutomationDraft = { name: '', app: '', path: '' };

/** A form that makes a draft automation by hand: one app and one menu path, such as "View > Clean Up". */
export function menuAutomationPanel(): HTMLElement {
  let createButton: HTMLButtonElement | undefined;
  const update = (field: keyof MenuAutomationDraft) => (event: Event) => {
    draft[field] = (event.currentTarget as HTMLInputElement).value;
    state.dirty.add(KEY);
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
      field('Menu path', 'path', 'View > Clean Up', 170),
    ),
    h('div', { class: 'actions' }, createButton),
  );
}
