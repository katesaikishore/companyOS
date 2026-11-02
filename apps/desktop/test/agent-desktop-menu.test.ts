import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { StepRefusedError, type Executor } from '@companyos/twin-core';
import { AgentDesktopSession, chooseMenuWithAgentDesktop, cursorFor, handsExecutor, type HandsOptions } from '../src/main/agent-desktop';
import { draftReady, parseMenuPath } from '../src/renderer/menu-automation-model';

/** The fake starts as a script with a shebang line, which Windows cannot run directly. */
const STARTS_FAKE_PROGRAM = process.platform !== 'win32';

/**
 * A stand-in for the agent-desktop program's menu commands. Each start appends its arguments, as one JSON line, to
 * FAKE_MENU_LOG. FAKE_MENU_SESSION "fail" makes session start fail. FAKE_MENU_MISSING names a label find does not find.
 * FAKE_MENU_ROLE sets the role of every match. FAKE_MENU_CLICK "unverified" makes every click unconfirmed. Per click, in
 * order, FAKE_MENU_DELIVERIES gives "v" (verified) or "u" (unverified), and FAKE_MENU_SURFACES gives how many menus are
 * open after it. By default every click is verified and the nth click leaves n menus open. FAKE_MENU_CLICK_FAIL names a
 * click, by number, that exits 1 with the code in FAKE_MENU_CLICK_CODE. FAKE_MENU_FIND_CODE is the code a missing label
 * fails with. FAKE_MENU_WAIT "open" makes the menu stay open.
 */
const FAKE_PROGRAM = [
  `#!${process.execPath}`,
  "const { appendFileSync } = require('node:fs');",
  'const args = process.argv.slice(2);',
  "appendFileSync(process.env.FAKE_MENU_LOG, JSON.stringify(args) + '\\n');",
  'const out = value => process.stdout.write(JSON.stringify(value));',
  '(() => {',
  "const after = flag => args[args.indexOf(flag) + 1];",
  "if (args[0] === 'session' && args[1] === 'start') {",
  "  if (process.env.FAKE_MENU_SESSION === 'fail') { out({ ok: false, error: { code: 'INTERNAL' } }); process.exitCode = 1; }",
  "  else out({ ok: true, data: { session_id: 'sess-1' } });",
  "} else if (args[0] === 'find') {",
  "  const name = after('--name');",
  "  if (name === process.env.FAKE_MENU_MISSING) { out({ ok: false, error: { code: process.env.FAKE_MENU_FIND_CODE || 'ELEMENT_NOT_FOUND' } }); process.exitCode = 1; }",
  "  else out({ ok: true, data: { match: { name, role: process.env.FAKE_MENU_ROLE || 'menuitem', ref_id: '@s1:e' + name.length } } });",
  "} else if (args[0] === 'click') {",
  "  const counter = process.env.FAKE_MENU_LOG + '.clicks';",
  "  const n = (require('node:fs').existsSync(counter) ? Number(require('node:fs').readFileSync(counter, 'utf8')) : 0) + 1;",
  "  require('node:fs').writeFileSync(counter, String(n));",
  "  const pick = (list, fallback) => (list ? list.split(',')[n - 1] : undefined) ?? fallback;",
  "  const verified = process.env.FAKE_MENU_CLICK !== 'unverified' && pick(process.env.FAKE_MENU_DELIVERIES, 'v') === 'v';",
  "  const menus = Number(pick(process.env.FAKE_MENU_SURFACES, String(n)));",
  "  if (String(n) === process.env.FAKE_MENU_CLICK_FAIL) { out({ ok: false, error: { code: process.env.FAKE_MENU_CLICK_CODE || 'TIMEOUT' } }); process.exitCode = 1; return; }",
  "  out({ ok: true, data: { disposition: { delivery: verified ? 'delivered_verified' : 'delivered_unverified' }, surfaces: Array.from({ length: menus }, () => ({ type: 'menu' })) } });",
  "} else if (args[0] === 'wait') out({ ok: true, data: { found: process.env.FAKE_MENU_WAIT !== 'open' } });",
  'else out({ ok: true, data: {} });',
  '})();',
  '',
].join('\n');

const KEYS = [
  'FAKE_MENU_LOG',
  'FAKE_MENU_SESSION',
  'FAKE_MENU_MISSING',
  'FAKE_MENU_ROLE',
  'FAKE_MENU_CLICK',
  'FAKE_MENU_DELIVERIES',
  'FAKE_MENU_SURFACES',
  'FAKE_MENU_WAIT',
  'FAKE_MENU_CLICK_FAIL',
  'FAKE_MENU_CLICK_CODE',
  'FAKE_MENU_FIND_CODE',
];
/** A menu bar item and one item in its menu: the only path the program can choose for now. */
const CLEAN_UP = ['View', 'Clean Up'];
const SUBMENU = ['View', 'Clean Up By', 'Name'];

let folder: string;
let program: string;
let logs = 0;

beforeAll(() => {
  folder = mkdtempSync(join(tmpdir(), 'agent-desktop-menu-'));
  program = join(folder, 'agent-desktop-fake');
  writeFileSync(program, FAKE_PROGRAM);
  chmodSync(program, 0o755);
});

afterAll(() => rmSync(folder, { recursive: true, force: true }));
afterEach(() => {
  for (const key of KEYS) delete process.env[key];
});

/**
 * Points the fake at a new log, clears every earlier setting, sets its behaviour, and returns a reader for the argument
 * lists it was started with.
 */
function fake(settings: Record<string, string> = {}): () => string[][] {
  const log = join(folder, `log-${logs++}.jsonl`);
  for (const key of KEYS) delete process.env[key];
  process.env.FAKE_MENU_LOG = log;
  for (const [key, value] of Object.entries(settings)) process.env[key] = value;
  return () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []);
}

function options(extra: Partial<HandsOptions> = {}): HandsOptions {
  return { binary: program, ...extra };
}

function withCursor(): HandsOptions {
  const session = new AgentDesktopSession(() => ({ binary: program }));
  return options({ session, cursor: cursorFor('menu-abc', 'Arrange the Desktop') });
}

describe('cursorFor', () => {
  it('makes an agent id the program accepts from the automation id, and labels the cursor with its name', () => {
    expect(cursorFor('menu-1f2e', 'Arrange the Desktop')).toEqual({ agentId: 'menu-1f2e', label: 'Arrange the Desktop' });
    expect(cursorFor('a b/c', 'x\u0007y')).toEqual({ agentId: 'a-b-c', label: 'x y' });
    expect(cursorFor('id', '--help me').label).toBe('help me');
    expect(cursorFor('id', '---').label).toBe('companyOS');
  });
});

describe('parseMenuPath', () => {
  it('splits on > and → and drops empty labels', () => {
    expect(parseMenuPath('View > Clean Up By > Name')).toEqual(SUBMENU);
    expect(parseMenuPath('File→Save As… > ')).toEqual(['File', 'Save As…']);
    expect(parseMenuPath('View > Open / Close')).toEqual(['View', 'Open / Close']);
  });

  it('accepts only a menu bar item and one item in its menu in the form', () => {
    expect(draftReady({ name: 'n', app: 'Finder', path: 'View' })).toBe(false);
    expect(draftReady({ name: 'n', app: 'Finder', path: 'View > Clean Up' })).toBe(true);
    expect(draftReady({ name: 'n', app: 'Finder', path: 'View > Clean Up By > Name' })).toBe(false);
  });
});

describe.runIf(STARTS_FAKE_PROGRAM)('chooseMenuWithAgentDesktop', () => {
  it('finds each label on its surface, clicks it under the automation cursor, and waits for the menu to close', async () => {
    const calls = fake();
    const result = await chooseMenuWithAgentDesktop(withCursor(), 'Finder', CLEAN_UP);
    expect(result).toEqual({ ok: true });
    const scope = ['--session', 'sess-1'];
    const actor = ['--agent-id', 'menu-abc'];
    expect(calls()).toEqual([
      ['session', 'start', '--name', 'companyOS', '--cursor', '--multi-agent', '--no-trace'],
      ['cursor-overlay', 'enable', '--label', 'Arrange the Desktop', ...scope, ...actor],
      ['find', '--app', 'Finder', '--surface', 'menubar', '--name', 'View', '--exact', '--first', ...scope],
      ['click', '@s1:e4', ...scope, ...actor],
      ['find', '--app', 'Finder', '--surface', 'menu', '--name', 'Clean Up', '--exact', '--first', ...scope],
      ['click', '@s1:e8', ...scope, ...actor],
      ['wait', '--menu-closed', '--app', 'Finder', '--timeout', '2000', ...scope],
    ]);
  });

  it('starts the session and styles the cursor once across runs', async () => {
    const calls = fake();
    const shared = withCursor();
    await chooseMenuWithAgentDesktop(shared, 'Finder', CLEAN_UP);
    await chooseMenuWithAgentDesktop(shared, 'Finder', CLEAN_UP);
    expect(calls().filter(args => args[0] === 'session').length).toBe(1);
    expect(calls().filter(args => args[0] === 'cursor-overlay').length).toBe(1);
  });

  it('runs with no session or agent id when the session cannot start', async () => {
    const calls = fake({ FAKE_MENU_SESSION: 'fail' });
    const result = await chooseMenuWithAgentDesktop(withCursor(), 'Finder', CLEAN_UP);
    expect(result).toEqual({ ok: true });
    const acts = calls().filter(args => args[0] === 'click');
    expect(acts.every(args => !args.includes('--session') && !args.includes('--agent-id'))).toBe(true);
  });

  it('stops before anything is chosen when a label is not found, and closes the open menu', async () => {
    const calls = fake({ FAKE_MENU_MISSING: 'Clean Up' });
    const result = await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP);
    expect(result).toMatchObject({ ok: false, failure: 'not_found' });
    expect(calls().filter(args => args[0] === 'click').length).toBe(1);
    expect(calls().at(-1)?.slice(0, 2)).toEqual(['press', 'escape']);
  });

  it('never clicks a match that is not a menu item', async () => {
    const calls = fake({ FAKE_MENU_ROLE: 'button' });
    const result = await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP);
    expect(result).toMatchObject({ ok: false, failure: 'not_found' });
    expect(calls().some(args => args[0] === 'click')).toBe(false);
  });

  it('stops at a menu-opening click that is not confirmed, and closes the menu', async () => {
    const calls = fake({ FAKE_MENU_CLICK: 'unverified' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toMatchObject({ ok: false, failure: 'unverified' });
    expect(calls().filter(args => args[0] === 'click').length).toBe(1);
    expect(calls().at(-1)?.slice(0, 2)).toEqual(['press', 'escape']);
  });

  it('accepts an unconfirmed last click, since the menu closes as the item runs, and then sends no Escape', async () => {
    const calls = fake({ FAKE_MENU_DELIVERIES: 'v,u', FAKE_MENU_SURFACES: '1,0' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toEqual({ ok: true });
    expect(calls().some(args => args[0] === 'press')).toBe(false);
  });

  it('refuses a path with a submenu before anything starts, since a middle click would run its item', async () => {
    const calls = fake();
    expect(await chooseMenuWithAgentDesktop(withCursor(), 'Finder', SUBMENU)).toMatchObject({ ok: false, failure: 'submenu' });
    expect(calls()).toEqual([]);
    const base: Executor = { focusApp: async () => true, frontmostApp: async () => 'Finder' };
    await expect(handsExecutor(base, options()).chooseMenu?.('Finder', SUBMENU)).rejects.toBeInstanceOf(StepRefusedError);
  });

  it('refuses a menu bar click that opened no menu, and sends no Escape to a window with no menu open', async () => {
    const calls = fake({ FAKE_MENU_SURFACES: '0' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toMatchObject({ ok: false, failure: 'submenu' });
    expect(calls().some(args => args[0] === 'press')).toBe(false);
  });

  it('sends no Escape when the menu bar click fails, or when the last click fails after it may have run', async () => {
    const first = fake({ FAKE_MENU_CLICK_FAIL: '1' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toMatchObject({ ok: false });
    expect(first().some(args => args[0] === 'press')).toBe(false);
    const lastClick = fake({ FAKE_MENU_CLICK_FAIL: '2' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toMatchObject({ ok: false });
    expect(lastClick().filter(args => args[0] === 'click').length).toBe(2);
    expect(lastClick().some(args => args[0] === 'press')).toBe(false);
  });

  it('drops a session that a call says is gone, so the next run starts a new one', async () => {
    const calls = fake({ FAKE_MENU_MISSING: 'View', FAKE_MENU_FIND_CODE: 'SESSION_NOT_FOUND' });
    const shared = withCursor();
    await chooseMenuWithAgentDesktop(shared, 'Finder', CLEAN_UP);
    await chooseMenuWithAgentDesktop(shared, 'Finder', CLEAN_UP);
    expect(calls().filter(args => args[0] === 'session' && args[1] === 'start').length).toBe(2);
  });

  it('labels the cursor again when the automation is renamed', async () => {
    const calls = fake();
    const session = new AgentDesktopSession(() => ({ binary: program }));
    await chooseMenuWithAgentDesktop(options({ session, cursor: cursorFor('menu-abc', 'Old name') }), 'Finder', CLEAN_UP);
    await chooseMenuWithAgentDesktop(options({ session, cursor: cursorFor('menu-abc', 'New name') }), 'Finder', CLEAN_UP);
    expect(calls().filter(args => args[0] === 'cursor-overlay').map(args => args[3])).toEqual(['Old name', 'New name']);
  });

  it('fails when the menu stays open after the last click, without sending Escape', async () => {
    const calls = fake({ FAKE_MENU_WAIT: 'open' });
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', CLEAN_UP)).toMatchObject({ ok: false, failure: 'unverified' });
    expect(calls().some(args => args[0] === 'press')).toBe(false);
  });

  it('starts nothing for a label or an app the program should not be given', async () => {
    const calls = fake();
    expect(await chooseMenuWithAgentDesktop(options(), 'Finder', ['View', '--headed'])).toMatchObject({ failure: 'invalid_input' });
    expect(await chooseMenuWithAgentDesktop(options(), '-Finder', CLEAN_UP)).toMatchObject({ failure: 'invalid_input' });
    expect(calls()).toEqual([]);
  });

  it('reaches the runner as a refusal for a missing label and as false for an unconfirmed click', async () => {
    const base: Executor = { focusApp: async () => true, frontmostApp: async () => 'Finder' };
    fake({ FAKE_MENU_MISSING: 'View' });
    const missing = handsExecutor(base, options());
    await expect(missing.chooseMenu?.('Finder', CLEAN_UP)).rejects.toBeInstanceOf(StepRefusedError);
    fake({ FAKE_MENU_CLICK: 'unverified' });
    await expect(handsExecutor(base, options()).chooseMenu?.('Finder', CLEAN_UP)).resolves.toBe(false);
  });

  it('ends the session it started', async () => {
    const calls = fake();
    const session = new AgentDesktopSession(() => ({ binary: program }));
    await session.id();
    await session.end();
    expect(calls().at(-1)).toEqual(['session', 'end', 'sess-1']);
  });
});
