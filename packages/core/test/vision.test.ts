import { describe, expect, it } from 'vitest';
import { discoverFromScreen, filterForModel, grounded, VISION_MAX_TOKENS, type VisionCompleter, type VisionRequest } from '../src/apps/vision';

const PNG = new Uint8Array([137, 80, 78, 71]);
const SURFACE = {
  app: 'companyOS Twin',
  controls: [
    'link "Overview"',
    'link "Settings"',
    'button "Search Ctrl / ⌘ K"',
    'button "Pause capture"',
    'button "Stop all automations"',
    'button "Rename Claude and Google Chrome"',
    'button "Merge Claude and Google Chrome with the next task"',
    'combobox "Split point for Claude and Google Chrome"',
    'button "Split Claude and Google Chrome at the chosen point"',
    'button "Confirm Claude and Google Chrome"',
    'button "Close"',
    'button "Zoom"',
    'button "Minimize"',
  ],
};

/** A vision model that gives one fixed reply and records the request it was given. */
function fakeVision(reply: unknown | (() => never)) {
  const requests: VisionRequest[] = [];
  const vision: VisionCompleter = {
    async describe(request) {
      requests.push(request);
      if (typeof reply === 'function') return (reply as () => never)();
      return reply;
    },
  };
  return { vision, requests };
}

describe('filterForModel', () => {
  it('removes tabs, links and the window buttons, and keeps the controls that can do work', () => {
    const kept = filterForModel(SURFACE).controls;
    expect(kept.some(control => control.startsWith('link'))).toBe(false);
    expect(kept).not.toContain('button "Close"');
    expect(kept).toContain('button "Stop all automations"');
    expect(kept).toContain('combobox "Split point for Claude and Google Chrome"');
    expect(kept).toHaveLength(8);
  });
});

describe('grounded', () => {
  const controls = SURFACE.controls;

  it('accepts a shortened name when the control is on the screen', () => {
    expect(grounded('Rename', controls)).toBe(true);
    expect(grounded('Merge with next', controls)).toBe(true);
    expect(grounded('Split at', controls)).toBe(true);
  });

  it('rejects a name that no control on the screen matches', () => {
    expect(grounded('Export data', controls)).toBe(false);
    expect(grounded('', controls)).toBe(false);
  });
});

describe('discoverFromScreen', () => {
  it('sends the picture and only the filtered controls, with no tabs or links in the prompt', async () => {
    const { vision, requests } = fakeVision({ capabilities: [] });
    await discoverFromScreen(vision, SURFACE, PNG);
    expect(requests[0].imagePng).toBe(PNG);
    expect(requests[0].maxTokens).toBe(VISION_MAX_TOKENS);
    expect(requests[0].prompt).toContain('button "Stop all automations"');
    expect(requests[0].prompt).not.toContain('link "Settings"');
    expect(requests[0].prompt).not.toContain('Minimize');
  });

  it('keeps grounded proposals and counts the ones it dropped', async () => {
    const { vision } = fakeVision({
      capabilities: [
        { name: 'Rename task', description: 'Renames the task.', risk: 'draft', control: 'Rename' },
        { name: 'Export data', description: 'Exports the data.', risk: 'read_only', control: 'Export my data' },
      ],
    });
    const result = await discoverFromScreen(vision, SURFACE, PNG);
    expect(result.capabilities.map(c => c.name)).toEqual(['Rename task']);
    expect(result.dropped).toBe(1);
    expect(result.controls).toBe(8);
  });

  it('applies the approval floor: a draft or a stop needs approval whatever the model said', async () => {
    const { vision } = fakeVision({
      capabilities: [
        { name: 'Stop all automations', description: 'Stops every run.', risk: 'read_only', control: 'Stop all automations' },
        { name: 'Confirm grouping', description: 'Confirms the task.', risk: 'read_only', control: 'Confirm' },
      ],
    });
    const result = await discoverFromScreen(vision, SURFACE, PNG);
    expect(result.capabilities.find(c => c.name === 'Stop all automations')).toMatchObject({ risk: 'destructive', needsApproval: true });
    expect(result.capabilities.find(c => c.name === 'Confirm grouping')?.needsApproval).toBe(false);
  });

  it('keeps one proposal per name', async () => {
    const { vision } = fakeVision({
      capabilities: [
        { name: 'Rename', description: 'One.', risk: 'draft', control: 'Rename' },
        { name: 'rename', description: 'Two.', risk: 'draft', control: 'Rename' },
      ],
    });
    expect((await discoverFromScreen(vision, SURFACE, PNG)).capabilities).toHaveLength(1);
  });

  it('gives no proposals when the model fails or its reply breaks the schema', async () => {
    const failing = fakeVision(() => {
      throw new Error('model stopped');
    });
    expect(await discoverFromScreen(failing.vision, SURFACE, PNG)).toMatchObject({ capabilities: [], reason: 'model_failed' });
    const bad = fakeVision({ capabilities: [{ name: 'Delete', description: 'x', risk: 'sometimes', control: 'Delete' }] });
    expect(await discoverFromScreen(bad.vision, SURFACE, PNG)).toMatchObject({ capabilities: [], reason: 'invalid_reply' });
  });

  it('asks nothing when the screen has no controls left after the filter', async () => {
    const { vision, requests } = fakeVision({ capabilities: [] });
    const onlyTabs = { app: 'Blank', controls: ['link "Overview"', 'button "Close"'] };
    expect(await discoverFromScreen(vision, onlyTabs, PNG)).toMatchObject({ capabilities: [], reason: 'no_controls' });
    expect(requests).toHaveLength(0);
  });
});
