import { describe, expect, it } from 'vitest';
import type { CompletionRequest, LocalCompleter } from '../src/llm/types';
import { MAX_CONTROLS, discoverCapabilities, learningNotes, riskOf, surfaceOf, type RunOutcome } from '../src/apps/capabilities';

/** A completer that gives one fixed reply, and records the request it was given. */
function fakeCompleter(reply: unknown | (() => never)) {
  const requests: CompletionRequest[] = [];
  const completer: LocalCompleter = {
    async complete(request) {
      requests.push(request);
      if (typeof reply === 'function') return (reply as () => never)();
      return reply;
    },
  };
  return { completer, requests };
}

const surface = { app: 'Slack', controls: ['button "Send"', 'textfield "Message"', 'menuitem "Preferences"'] };

describe('surfaceOf', () => {
  it('lists the named controls by role and name, and never a value', () => {
    const snapshot = {
      data: {
        tree: {
          role: 'window',
          name: 'Slack',
          children: [
            { role: 'textfield', name: 'Message', value: 'a private message body' },
            { role: 'button', name: 'Send' },
            { role: 'statictext', name: 'Hello there' },
            { role: 'button', name: 'Send' },
          ],
        },
      },
    };
    const result = surfaceOf('Slack', snapshot);
    expect(result.controls).toEqual(['textfield "Message"', 'button "Send"']);
    expect(JSON.stringify(result)).not.toContain('private message body');
  });

  it('cuts a long screen to the control limit', () => {
    const children = Array.from({ length: MAX_CONTROLS + 20 }, (_, i) => ({ role: 'button', name: `b${i}` }));
    expect(surfaceOf('App', { data: { tree: { children } } }).controls).toHaveLength(MAX_CONTROLS);
  });

  it('returns no controls for a snapshot without a tree', () => {
    expect(surfaceOf('App', null).controls).toEqual([]);
  });
});

describe('discoverCapabilities', () => {
  it('turns a valid reply into capabilities, and requires approval for anything that is not a read', async () => {
    const { completer, requests } = fakeCompleter({
      capabilities: [
        { name: 'Read unread messages', description: 'Lists the channels with new messages.', risk: 'read_only' },
        { name: 'Draft a reply', description: 'Writes a reply in the message box.', risk: 'draft' },
        { name: 'Send a message', description: 'Posts the message to the channel.', risk: 'outbound' },
      ],
    });
    const result = await discoverCapabilities(completer, surface);
    expect(result.reason).toBeUndefined();
    expect(result.capabilities.map(c => [c.name, c.needsApproval])).toEqual([
      ['Read unread messages', false],
      ['Draft a reply', true],
      ['Send a message', true],
    ]);
    expect(requests[0].prompt).toContain('button "Send"');
    expect(requests[0].prompt).toContain('/no_think');
  });

  it('drops a repeated name', async () => {
    const { completer } = fakeCompleter({
      capabilities: [
        { name: 'Send', description: 'One.', risk: 'outbound' },
        { name: 'send', description: 'Two.', risk: 'outbound' },
      ],
    });
    expect((await discoverCapabilities(completer, surface)).capabilities).toHaveLength(1);
  });

  it('gives no capabilities for a reply that does not match the schema', async () => {
    const { completer } = fakeCompleter({ capabilities: [{ name: 'Delete all', description: 'x', risk: 'sometimes' }] });
    expect(await discoverCapabilities(completer, surface)).toEqual({ capabilities: [], reason: 'invalid_reply' });
  });

  it('requires approval for a pause the model called a read', async () => {
    const { completer } = fakeCompleter({ capabilities: [{ name: 'Pause capture', description: 'Stops recording.', risk: 'read_only' }] });
    const [only] = (await discoverCapabilities(completer, surface)).capabilities;
    expect(only).toMatchObject({ risk: 'draft', needsApproval: true });
  });

  it('gives no capabilities when the model fails', async () => {
    const { completer } = fakeCompleter(() => {
      throw new Error('model stopped');
    });
    expect(await discoverCapabilities(completer, surface)).toEqual({ capabilities: [], reason: 'model_failed' });
  });

  it('asks nothing when there are no controls to read', async () => {
    const { completer, requests } = fakeCompleter({ capabilities: [] });
    expect(await discoverCapabilities(completer, { app: 'Blank', controls: [] })).toEqual({ capabilities: [], reason: 'no_controls' });
    expect(requests).toHaveLength(0);
  });

  it('passes what the user did before into the prompt', async () => {
    const { completer, requests } = fakeCompleter({ capabilities: [] });
    await discoverCapabilities(completer, surface, { learned: '- Draft a reply: approved 3, rejected 0, edited 1' });
    expect(requests[0].prompt).toContain('approved 3');
  });
});

describe('riskOf', () => {
  it('keeps a read a read, and raises a pause, a send or a delete whatever the model said', () => {
    expect(riskOf('Recall past work', 'read_only')).toBe('read_only');
    expect(riskOf('Pause capture', 'read_only')).toBe('draft');
    expect(riskOf('Send a message', 'read_only')).toBe('outbound');
    expect(riskOf('Stop all automations', 'read_only')).toBe('destructive');
  });

  it('never lowers the model\'s own higher label', () => {
    expect(riskOf('Open the inbox', 'destructive')).toBe('destructive');
  });
});

describe('learningNotes', () => {
  const outcomes: RunOutcome[] = [
    { app: 'Slack', capability: 'Draft a reply', decision: 'approved', at: 1 },
    { app: 'Slack', capability: 'Draft a reply', decision: 'edited', edited: 'Thanks, will do.', at: 2 },
    { app: 'Slack', capability: 'Send a message', decision: 'rejected', at: 3 },
    { app: 'Mail', capability: 'Draft a reply', decision: 'approved', at: 4 },
  ];

  it('counts decisions for one application only', () => {
    const notes = learningNotes(outcomes, 'Slack');
    expect(notes).toContain('- Draft a reply: approved 1, rejected 0, edited 1');
    expect(notes).toContain('- Send a message: approved 0, rejected 1, edited 0');
    expect(notes).not.toContain('Mail');
  });

  it('keeps the most recent edited wording first, cut to a short length', () => {
    const longEdit: RunOutcome = { app: 'Slack', capability: 'Draft a reply', decision: 'edited', edited: 'x'.repeat(500), at: 9 };
    const notes = learningNotes([...outcomes, longEdit], 'Slack');
    const first = notes.split('\n').find(line => line.includes('wording'))!;
    expect(first.length).toBeLessThan(260);
    expect(first).toContain('x'.repeat(200));
  });

  it('is empty for an application the user has not used', () => {
    expect(learningNotes(outcomes, 'Notes')).toBe('');
  });
});
