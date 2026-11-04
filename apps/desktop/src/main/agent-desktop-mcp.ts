import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ActResult, Observation, OperatorAction, OperatorHands } from '@companyos/twin-core';
import { z } from 'zod';

/**
 * agent-desktop as an MCP server, and the task operator's hands as an MCP client of it. Every reading of an app and every
 * action is an MCP tool call: observe, click, type, press, scroll, launch, focus_app, menu, and list_apps for the apps with
 * windows. The two ends are joined in memory inside the app, so nothing listens on a port or a pipe another program could
 * reach. The operator's checks run before a tool is called: an action that may send, share, spend or lose work still waits
 * for the person, and an excluded app is never read.
 */

/** An action the hands carry out: every action but done and fail, which end a task without touching an app. */
type HandAction = Exclude<OperatorAction, { type: 'done' } | { type: 'fail' }>;

const APP = z.string().min(1).max(80);
const REF = z.string().min(1).max(200);
const REASON = z.string().max(300).default('');

function json(value: unknown): { content: Array<{ type: 'text'; text: string }> } {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/**
 * The agent-desktop MCP server over a set of hands. It keeps the last reading of each app, which an action on that app is
 * checked against, as the hands need: a typed line goes after the text already in the field.
 */
export function agentDesktopServer(hands: OperatorHands, listApps: () => Promise<string[]>): McpServer {
  const server = new McpServer({ name: 'agent-desktop', version: '1.0.0' });
  const readings = new Map<string, Observation>();
  const act = async (app: string, action: HandAction, signal: AbortSignal): Promise<ActResult> => hands.act(action, readings.get(app) ?? { app, controls: [] }, signal);

  server.registerTool(
    'observe',
    { description: 'Reads an app’s front window: its title and its controls, each with a ref that one action can use. Refs change after every action.', inputSchema: { app: APP } },
    async ({ app }, extra) => {
      const reading = await hands.observe(app, extra.signal);
      readings.set(app, reading);
      return json(reading);
    },
  );
  server.registerTool(
    'click',
    { description: 'Clicks a control of the app by its ref from the last observe.', inputSchema: { app: APP, ref: REF, reason: REASON } },
    async ({ app, ref, reason }, extra) => json(await act(app, { type: 'click', ref, reason }, extra.signal)),
  );
  server.registerTool(
    'type',
    { description: 'Types text into a text field of the app by its ref. The text goes after the text already there.', inputSchema: { app: APP, ref: REF, text: z.string().min(1).max(10_000), reason: REASON } },
    async ({ app, ref, text, reason }, extra) => json(await act(app, { type: 'type', ref, text, reason }, extra.signal)),
  );
  server.registerTool(
    'press',
    { description: 'Presses a key combo in the app, such as cmd+n, return or escape.', inputSchema: { app: APP, keys: z.string().min(1).max(40), reason: REASON } },
    async ({ app, keys, reason }, extra) => json(await act(app, { type: 'press', keys, reason }, extra.signal)),
  );
  server.registerTool(
    'scroll',
    { description: 'Scrolls a control of the app up or down by its ref.', inputSchema: { app: APP, ref: REF, direction: z.enum(['up', 'down']), reason: REASON } },
    async ({ app, ref, direction, reason }, extra) => json(await act(app, { type: 'scroll', ref, direction, reason }, extra.signal)),
  );
  server.registerTool(
    'launch',
    { description: 'Opens an app by name and waits for its window.', inputSchema: { app: APP, reason: REASON } },
    async ({ app, reason }, extra) => json(await act(app, { type: 'launch', app, reason }, extra.signal)),
  );
  server.registerTool(
    'focus_app',
    { description: 'Brings a running app to the front by name.', inputSchema: { app: APP, reason: REASON } },
    async ({ app, reason }, extra) => json(await act(app, { type: 'focus_app', app, reason }, extra.signal)),
  );
  server.registerTool(
    'menu',
    {
      description: 'Chooses an item from the app’s menu bar: the menu, any submenus, then the item, such as ["View", "Sort By", "Kind"].',
      inputSchema: { app: APP, path: z.array(z.string().min(1).max(80)).min(2).max(4), reason: REASON },
    },
    async ({ app, path, reason }, extra) => json(await act(app, { type: 'menu', path, reason }, extra.signal)),
  );
  server.registerTool('list_apps', { description: 'Lists the apps that have windows, by name.', inputSchema: {} }, async () => json(await listApps()));
  return server;
}

/** The tool call that carries out an action: its name and arguments. */
export function toolCall(action: HandAction, app: string): { name: string; arguments: Record<string, unknown> } {
  switch (action.type) {
    case 'click':
      return { name: 'click', arguments: { app, ref: action.ref, reason: action.reason } };
    case 'type':
      return { name: 'type', arguments: { app, ref: action.ref, text: action.text, reason: action.reason } };
    case 'press':
      return { name: 'press', arguments: { app, keys: action.keys, reason: action.reason } };
    case 'scroll':
      return { name: 'scroll', arguments: { app, ref: action.ref, direction: action.direction, reason: action.reason } };
    case 'launch':
    case 'focus_app':
      return { name: action.type, arguments: { app: action.app, reason: action.reason } };
    case 'menu':
      return { name: 'menu', arguments: { app, path: [...action.path], reason: action.reason } };
  }
}

/**
 * The operator's hands as an MCP client: it connects to a fresh agent-desktop server on first use, and each reading and
 * action is a tool call. A tool that fails comes back as an error, so a failed reading never looks like an empty screen.
 */
export function mcpHands(serverFor: () => McpServer): OperatorHands {
  let connecting: Promise<Client> | undefined;
  const client = (): Promise<Client> =>
    (connecting ??= (async () => {
      const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
      await serverFor().connect(serverSide);
      const connected = new Client({ name: 'companyos-operator', version: '1.0.0' });
      await connected.connect(clientSide);
      return connected;
    })());
  const call = async (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> => {
    const result = await (await client()).callTool({ name, arguments: args }, undefined, signal ? { signal } : undefined);
    const parts = Array.isArray(result.content) ? (result.content as Array<{ type?: unknown; text?: unknown }>) : [];
    const text = parts.find(part => part.type === 'text' && typeof part.text === 'string')?.text as string | undefined;
    if (result.isError || text === undefined) throw new Error(text || `The agent-desktop tool ${name} failed.`);
    return JSON.parse(text) as unknown;
  };
  return {
    async observe(app, signal) {
      return (await call('observe', { app }, signal)) as Observation;
    },
    async act(action, observation, signal) {
      const { name, arguments: args } = toolCall(action, observation.app);
      return (await call(name, args, signal)) as ActResult;
    },
  };
}
