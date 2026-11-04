import { describe, expect, it } from 'vitest';
import type { ActResult, Observation, OperatorHands } from '@companyos/twin-core';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { agentDesktopServer, mcpHands, toolCall } from '../src/main/agent-desktop-mcp';

const textEdit: Observation = { app: 'TextEdit', window: 'Untitled', controls: [{ ref: '@t:e2', role: 'textarea', name: '', value: 'Release notes' }] };

function fakeHands(options: { failRead?: boolean } = {}) {
  const acted: Array<{ type: string; observation: Observation }> = [];
  const hands: OperatorHands = {
    async observe(app) {
      if (options.failRead) throw new Error('agent-desktop could not read that application.');
      return { ...textEdit, app };
    },
    async act(action, observation): Promise<ActResult> {
      acted.push({ type: action.type, observation });
      return { delivery: 'delivered' };
    },
  };
  return { hands, acted };
}

describe('agent-desktop over MCP', () => {
  it('reads an app and acts on it through tool calls, with the last reading of that app', async () => {
    const { hands, acted } = fakeHands();
    const remote = mcpHands(() => agentDesktopServer(hands, async () => ['TextEdit', 'Finder']));
    expect(await remote.observe('TextEdit')).toEqual(textEdit);
    expect(await remote.act({ type: 'type', ref: '@t:e2', text: 'Ship it', reason: 'add a line' }, textEdit)).toEqual({ delivery: 'delivered' });
    expect(await remote.act({ type: 'press', keys: 'cmd+s', reason: 'save' }, textEdit)).toEqual({ delivery: 'delivered' });
    expect(acted.map(entry => entry.type)).toEqual(['type', 'press']);
    expect(acted[0].observation.controls[0].value).toBe('Release notes');
  });

  it('reports a failed reading as an error, never as an empty screen', async () => {
    const remote = mcpHands(() => agentDesktopServer(fakeHands({ failRead: true }).hands, async () => []));
    await expect(remote.observe('Nowhere')).rejects.toThrow('could not read');
  });

  it('lists its tools and the apps with windows to any MCP client', async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await agentDesktopServer(fakeHands().hands, async () => ['TextEdit', 'Finder']).connect(serverSide);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(clientSide);
    const names = (await client.listTools()).tools.map(tool => tool.name).sort();
    expect(names).toEqual(['click', 'focus_app', 'launch', 'list_apps', 'menu', 'observe', 'press', 'scroll', 'type']);
    const apps = await client.callTool({ name: 'list_apps', arguments: {} });
    expect(JSON.parse((apps.content as Array<{ text: string }>)[0].text)).toEqual(['TextEdit', 'Finder']);
  });

  it('turns each action into its tool call, launch and focus by the app they name', () => {
    expect(toolCall({ type: 'click', ref: '@a:e1', reason: 'x' }, 'Finder')).toEqual({ name: 'click', arguments: { app: 'Finder', ref: '@a:e1', reason: 'x' } });
    expect(toolCall({ type: 'launch', app: 'TextEdit', reason: 'x' }, 'Finder')).toEqual({ name: 'launch', arguments: { app: 'TextEdit', reason: 'x' } });
    expect(toolCall({ type: 'menu', path: ['View', 'Use Stacks'], reason: 'x' }, 'Finder')).toEqual({ name: 'menu', arguments: { app: 'Finder', path: ['View', 'Use Stacks'], reason: 'x' } });
  });
});
