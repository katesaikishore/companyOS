import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StepRefusedError } from '@companyos/twin-core';
import type { HandsOptions } from '../src/main/agent-desktop';
import {
  clickWithAgentDesktop,
  fillWithAgentDesktop,
  pasteWithAgentDesktop,
  pressKeyWithAgentDesktop,
  readTextWithAgentDesktop,
  setFieldWithAgentDesktop,
} from '../src/main/desktop-actions';

/** The fake starts as a script with a shebang line, which Windows cannot run directly. */
const STARTS_FAKE_PROGRAM = process.platform !== 'win32';

/**
 * A stand-in for the agent-desktop commands the desktop steps use. Each start appends its arguments, as one JSON line, to
 * FAKE_DESK_LOG. list-windows prints FAKE_DESK_WINDOWS. find prints the matches for its role from FAKE_DESK_FIND, a JSON
 * object keyed by role. A textfield search after a paste reports the focused field with the value in FAKE_DESK_FIELD.
 */
const FAKE_PROGRAM = [
  `#!${process.execPath}`,
  "const { appendFileSync } = require('node:fs');",
  'const args = process.argv.slice(2);',
  "appendFileSync(process.env.FAKE_DESK_LOG, JSON.stringify(args) + '\\n');",
  'const out = value => process.stdout.write(JSON.stringify(value));',
  "const after = flag => args[args.indexOf(flag) + 1];",
  "if (args[0] === 'list-windows') out({ ok: true, data: JSON.parse(process.env.FAKE_DESK_WINDOWS || '[]') });",
  "else if (args[0] === 'find') {",
  "  const role = after('--role');",
  "  const table = JSON.parse(process.env.FAKE_DESK_FIND || '{}');",
  "  let matches = table[role] || [];",
  "  if (require('node:fs').existsSync(process.env.FAKE_DESK_LOG + '.scrolled')) matches = matches.map(m => m.bounds && m.bounds.width === 1 ? { ...m, bounds: { ...m.bounds, width: 60 } } : m);",
  "  if (role === 'textfield' && process.env.FAKE_DESK_FIELD !== undefined) matches = matches.concat([{ ref_id: '@s1:e9', role, states: ['focused'], value: process.env.FAKE_DESK_FIELD }]);",
  "  if (args.includes('--first')) { const name = after('--name'); const m = matches.find(x => x.name === name); out({ ok: true, data: m ? { match: m } : {} }); }",
  '  else out({ ok: true, data: { matches } });',
  "} else if (args[0] === 'scroll-to') { require('node:fs').writeFileSync(process.env.FAKE_DESK_LOG + '.scrolled', ''); out({ ok: true, data: {} }); }",
  'else out({ ok: true, data: {} });',
  '',
].join('\n');

const KEYS = ['FAKE_DESK_LOG', 'FAKE_DESK_WINDOWS', 'FAKE_DESK_FIND', 'FAKE_DESK_FIELD'];
const WINDOW = { id: 'w-1', title: 'Benchmark - Google Sheets', visible: true, bounds: { x: 0, y: 0, width: 800, height: 800 } };
const OTHER = { id: 'w-2', title: 'Untitled document - Google Docs', visible: true, bounds: { x: 0, y: 0, width: 800, height: 800 } };
const STRIP = { id: 'w-3', title: 'Google Chrome', visible: true, bounds: { x: 0, y: 0, width: 1440, height: 24 } };
const NAME_BOX = { ref_id: '@s1:e1', role: 'group', name: 'Name box (⌘ + J)', bounds: { x: 10, y: 20, width: 90, height: 24 } };

let folder: string;
let program: string;
let logs = 0;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'desktop-actions-'));
  program = join(folder, 'agent-desktop-fake');
  writeFileSync(program, FAKE_PROGRAM);
  chmodSync(program, 0o755);
});
afterAll(() => rmSync(folder, { recursive: true, force: true }));
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

function fake(settings: { windows?: unknown[]; find?: Record<string, unknown[]>; field?: string } = {}): () => string[][] {
  const log = join(folder, `log-${logs++}.jsonl`);
  for (const key of KEYS) delete process.env[key];
  process.env.FAKE_DESK_LOG = log;
  process.env.FAKE_DESK_WINDOWS = JSON.stringify(settings.windows ?? [WINDOW, STRIP]);
  process.env.FAKE_DESK_FIND = JSON.stringify(settings.find ?? {});
  if (settings.field !== undefined) process.env.FAKE_DESK_FIELD = settings.field;
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
}

/** A clipboard that remembers every write. */
function clipboard(initial = 'person’s own text') {
  const writes: string[] = [];
  let value = initial;
  return {
    writes,
    readText: () => value,
    writeText: (text: string) => {
      writes.push(text);
      value = text;
    },
  };
}

function options(extra: Partial<HandsOptions> = {}): HandsOptions {
  return { binary: program, ...extra };
}

const verbs = (calls: string[][]) => calls.map(args => args[0]);

describe.runIf(STARTS_FAKE_PROGRAM)('the desktop steps through agent-desktop', () => {
  it('chooses the window by the start of its title, brings it forward and clicks the element at its centre', async () => {
    const calls = fake({ windows: [OTHER, WINDOW, STRIP], find: { group: [NAME_BOX] } });
    await expect(clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'group', namePrefix: 'Name box' }, 'left')).resolves.toBe(true);
    expect(calls()).toEqual([
      ['list-windows', '--app', 'Google Chrome'],
      ['find', '--app', 'Google Chrome', '--window-id', 'w-1', '--role', 'group', '--limit', '0'],
      ['focus-window', '--window-id', 'w-1'],
      ['mouse-click', '--xy', '55,32', '--button', 'left', '--headed'],
    ]);
  });

  it('refuses several windows when the step names none, and a window or element that is not there, before acting', async () => {
    fake({ windows: [WINDOW, OTHER] });
    await expect(pressKeyWithAgentDesktop(options(), 'Google Chrome', undefined, 'return')).rejects.toThrow(StepRefusedError);
    const missingWindow = fake();
    await expect(pressKeyWithAgentDesktop(options(), 'Google Chrome', 'Quarterly', 'return')).rejects.toThrow(/No open window/);
    expect(verbs(missingWindow())).toEqual(['list-windows']);
    const missingElement = fake({ find: { button: [{ ref_id: '@s1:e2', role: 'button', name: 'Cancel' }] } });
    await expect(clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'button', name: 'OK' }, 'left')).rejects.toThrow(/not found/);
    expect(verbs(missingElement())).not.toContain('click');
  });

  it('clicks a dialog button and never the same-named button behind the dialog', async () => {
    const calls = fake({
      find: {
        button: [
          { ref_id: '@s1:e3', role: 'button', name: 'OK', path: ['window', 'group'] },
          { ref_id: '@s1:e4', role: 'button', name: 'OK', path: ['window', 'alertdialog', 'group'] },
        ],
      },
    });
    await clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'button', name: 'OK', inDialog: true }, 'left');
    expect(calls().at(-1)).toEqual(['click', '@s1:e4', '--headed']);
  });

  it('pastes through the app and puts the person’s clipboard back afterwards', async () => {
    const calls = fake();
    const board = clipboard();
    await expect(pasteWithAgentDesktop(options({ clipboard: board }), 'Google Chrome', 'Benchmark', '=SUM(A1:A3)')).resolves.toBe(true);
    expect(board.writes).toEqual(['=SUM(A1:A3)', 'person’s own text']);
    expect(calls().at(-1)).toEqual(['press', 'cmd+v', '--window-id', 'w-1', '--headed']);
  });

  it('submits a field only when the focused field shows exactly the text', async () => {
    const good = fake({ find: { group: [NAME_BOX] }, field: 'Finance!A1:D4' });
    await expect(
      fillWithAgentDesktop(options({ clipboard: clipboard() }), 'Google Chrome', 'Benchmark', { role: 'group', namePrefix: 'Name box' }, 'Finance!A1:D4', true),
    ).resolves.toBe(true);
    expect(good().at(-1)).toEqual(['press', 'return', '--window-id', 'w-1', '--headed']);

    const bad = fake({ find: { group: [NAME_BOX] }, field: 'A1' });
    await expect(
      fillWithAgentDesktop(options({ clipboard: clipboard() }), 'Google Chrome', 'Benchmark', { role: 'group', namePrefix: 'Name box' }, 'Finance!A1:D4', true),
    ).resolves.toBe(false);
    const presses = bad().filter(args => args[0] === 'press').map(args => args[1]);
    // Filled twice, each time cleared with Escape, and never submitted.
    expect(presses.filter(key => key === 'escape')).toHaveLength(2);
    expect(presses).not.toContain('return');
  }, 15_000);

  it('types into a native field through its ref, and refuses text that would read as an option', async () => {
    const field = { ref_id: '@s1:e5', role: 'textfield', name: 'Name', value: 'untitled folder' };
    const calls = fake({ windows: [{ ...WINDOW, title: 'untitled folder Info' }], find: { textfield: [field] } });
    await expect(setFieldWithAgentDesktop(options(), 'Finder', 'untitled folder Info', { role: 'textfield', name: 'Name' }, 'Finance')).resolves.toBe(true);
    // Focused, its text selected, then typed over: never left empty on the way.
    expect(calls().slice(-3)).toEqual([
      ['click', '@s1:e5', '--headed'],
      ['press', 'cmd+a', '--window-id', 'w-1', '--headed'],
      ['type', '@s1:e5', 'Finance', '--headed'],
    ]);
    expect(verbs(calls())).not.toContain('clear');
    fake({ windows: [{ ...WINDOW, title: 'untitled folder Info' }], find: { textfield: [field] } });
    await expect(setFieldWithAgentDesktop(options(), 'Finder', 'untitled folder Info', { role: 'textfield', name: 'Name' }, '--help')).rejects.toThrow(/dash/);
  });

  it('reads the window’s text once per cell, and reads the clipboard without calling the program', async () => {
    fake({
      find: {
        statictext: [
          { role: 'statictext', name: 'Method', path: ['table', 'row', 'cell'] },
          { role: 'statictext', name: 'cod', path: ['table', 'row', 'cell'] },
          { role: 'statictext', name: 'Method', path: ['table', 'column', 'cell'] },
        ],
      },
    });
    await expect(readTextWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', 'window')).resolves.toBe('Method\ncod');
    const calls = fake();
    await expect(readTextWithAgentDesktop(options({ clipboard: clipboard('171') }), 'Google Chrome', 'Benchmark', 'clipboard')).resolves.toBe('171');
    expect(calls()).toEqual([]);
  });

  it('prefers the window whose title is exactly the name over one that only starts with it', async () => {
    const reader = { ...OTHER, id: 'w-5', title: 'Summary' };
    const editor = { ...OTHER, id: 'w-6', title: 'Summary - Google Docs' };
    const calls = fake({ windows: [editor, reader] });
    await pressKeyWithAgentDesktop(options(), 'Google Chrome', 'Summary', 'cmd+r');
    expect(calls().at(-1)).toEqual(['press', 'cmd+r', '--window-id', 'w-5', '--headed']);
  });

  it('scrolls an element that is out of view into view, then clicks it where it now is', async () => {
    const hiddenTab = { ref_id: '@s1:e8', role: 'statictext', name: 'Scratch', bounds: { x: 887, y: 818, width: 1, height: 18 } };
    const calls = fake({ find: { statictext: [hiddenTab] } });
    await expect(clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'statictext', name: 'Scratch' }, 'right')).resolves.toBe(true);
    // Asked for by name first; out of view, so listed in full, scrolled into view, and looked for again.
    expect(verbs(calls())).toEqual(['list-windows', 'find', 'find', 'scroll-to', 'find', 'focus-window', 'mouse-click']);
    expect(calls().at(-1)).toEqual(['mouse-click', '--xy', '917,827', '--button', 'right', '--headed']);
  });

  it('double-clicks at the element’s centre, such as a sheet tab to rename it', async () => {
    const tab = { ref_id: '@s1:e8', role: 'statictext', name: 'Sheet7', bounds: { x: 100, y: 818, width: 60, height: 18 } };
    const calls = fake({ find: { statictext: [tab] } });
    await clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'statictext', namePrefix: 'Sheet' }, 'left', 2);
    expect(calls().at(-1)).toEqual(['mouse-click', '--xy', '130,827', '--button', 'left', '--count', '2', '--headed']);
  });

  it('asks for an exactly named element directly, so a window too large to list still works', async () => {
    const item = { ref_id: '@s1:e3', role: 'image', name: 'companyOS Duplicates' };
    const calls = fake({ find: { image: [item] } });
    await clickWithAgentDesktop(options(), 'Google Chrome', 'Benchmark', { role: 'image', name: 'companyOS Duplicates' }, 'left', 2);
    expect(calls().filter(args => args[0] === 'find')).toEqual([
      ['find', '--app', 'Google Chrome', '--window-id', 'w-1', '--role', 'image', '--name', 'companyOS Duplicates', '--first'],
    ]);
    expect(calls().at(-1)).toEqual(['double-click', '@s1:e3', '--headed']);
  });

  it('finds a nameless field by its value', async () => {
    const field = { ref_id: '@s1:e7', role: 'textfield', value: 'untitled folder' };
    const calls = fake({ windows: [{ ...WINDOW, title: 'untitled folder Info' }], find: { textfield: [field] } });
    await setFieldWithAgentDesktop(options(), 'Finder', 'untitled folder Info', { role: 'textfield', value: 'untitled folder' }, 'Audit');
    expect(calls().at(-1)).toEqual(['type', '@s1:e7', 'Audit', '--headed']);
  });

  it('goes to where to paste and pastes in one call, and pastes nothing when the field does not show the place', async () => {
    const good = fake({ find: { group: [NAME_BOX] }, field: "'City Desk'!B2" });
    const board = clipboard();
    const via = { target: { role: 'group' as const, namePrefix: 'Name box' }, text: "'City Desk'!B2" };
    await expect(pasteWithAgentDesktop(options({ clipboard: board }), 'Google Chrome', 'Benchmark', '=COUNTIF(A:A,"x")', via)).resolves.toBe(true);
    expect(good().filter(args => args[0] === 'press').map(args => args[1])).toEqual(['cmd+a', 'cmd+v', 'return', 'cmd+v']);
    expect(board.writes).toContain('=COUNTIF(A:A,"x")');

    const bad = fake({ find: { group: [NAME_BOX] }, field: 'A1' });
    const untouched = clipboard();
    await expect(pasteWithAgentDesktop(options({ clipboard: untouched }), 'Google Chrome', 'Benchmark', '=COUNTIF(A:A,"x")', via)).resolves.toBe(false);
    expect(untouched.writes).not.toContain('=COUNTIF(A:A,"x")');
    expect(bad().filter(args => args[0] === 'press').map(args => args[1])).not.toContain('return');
  }, 15_000);

  it('runs every call in the session under the automation’s cursor', async () => {
    const session = { id: async () => 'sess-1', style: async () => undefined, forget: () => undefined } as unknown as HandsOptions['session'];
    const calls = fake();
    await pressKeyWithAgentDesktop(
      options({ session, cursor: { agentId: 'playbook-1', label: 'Finance', colour: '#0090FF' } }),
      'Google Chrome',
      'Benchmark',
      'escape',
    );
    expect(calls().every(args => args.slice(-4).join(' ') === '--session sess-1 --agent-id playbook-1')).toBe(true);
  });
});
