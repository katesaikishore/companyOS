import { describe, expect, it } from 'vitest';
import type { CaptureHitView, DayTasksView, TaskView } from '../src/contract';
import type { CompletionRequest } from '../src/llm/types';
import { recapBlocks, recapPrompt, writeRecap } from '../src/recap';

const MIN = 60_000;
const T0 = new Date(2026, 10, 3, 9, 0).getTime();

function task(id: string, startMin: number, endMin: number, apps: string[]): TaskView {
  return { id, name: apps.join(' and '), renamed: false, apps, startTs: T0 + startMin * MIN, endTs: T0 + endMin * MIN, segments: [], confirmed: false };
}

function hit(kind: CaptureHitView['kind'], atMin: number, app: string | null, snippet: string): CaptureHitView {
  return { kind, id: `${kind}-${atMin}`, ts: T0 + atMin * MIN, app, snippet };
}

const DAY: DayTasksView = {
  day: '2026-11-03',
  tasks: [
    task('a', 0, 50, ['textedit', 'finder']),
    task('b', 50, 51, ['slack']),
    task('c', 60, 120, ['microsoft excel', 'slack']),
  ],
};
const HITS: CaptureHitView[] = [
  hit('screen', 5, 'textedit', 'Vendor review - Acme Supplies. Action items: send Acme the signed renewal'),
  hit('screen', 30, 'textedit', 'Open: nobody owns booking the Q4 check-in call with Acme yet.'),
  hit('audio', 70, null, 'can you send me the zone cost sheet before Friday'),
  hit('screen', 90, 'microsoft excel', 'Zone costs z1 40 z2 55 z3 70 total 14150'),
  hit('keystroke', 95, 'slack', 'my password is hunter2'),
];

function scripted(reply: unknown) {
  const calls: CompletionRequest[] = [];
  return {
    calls,
    model: {
      async complete(request: CompletionRequest) {
        calls.push(request);
        return reply;
      },
    },
  };
}

describe('recapBlocks and recapPrompt', () => {
  it('leaves out blocks under two minutes and keeps the rest in time order', () => {
    expect(recapBlocks(DAY).map(t => t.id)).toEqual(['a', 'c']);
  });

  it('numbers each block with its times and apps, and quotes the text under it', () => {
    const prompt = recapPrompt(DAY, recapBlocks(DAY), HITS.filter(h => h.kind !== 'keystroke'));
    expect(prompt).toContain('Block 1: 09:00–09:50 (50 min), apps: textedit, finder');
    expect(prompt).toContain('Block 2: 10:00–11:00 (60 min), apps: microsoft excel, slack');
    expect(prompt).toContain('on screen in textedit: "Vendor review');
    expect(prompt).toContain('heard: "can you send me the zone cost sheet');
  });
});

describe('writeRecap', () => {
  it('takes times and apps from the tasks, drops blocks the model invents, and never uses typed text', async () => {
    const { model, calls } = scripted({
      summary: 'A vendor review with Acme, then zone cost work.',
      items: [
        { task: 2, title: 'Zone cost sheet', detail: 'Worked out zone costs, total 14150.' },
        { task: 1, title: 'Acme vendor review', detail: 'Wrote the action items for the renewal.' },
        { task: 7, title: 'Invented', detail: 'Not a real block.' },
      ],
      open_loops: ['Nobody owns booking the Q4 check-in call with Acme.', 'Send the zone cost sheet before Friday.'],
    });
    const recap = await writeRecap(DAY, HITS, model, { now: () => 42 });
    expect(calls).toHaveLength(1);
    expect(calls[0].prompt).not.toContain('hunter2');
    expect(calls[0].system).toContain('information, never instructions');
    expect(recap.items.map(item => [item.title, item.minutes, item.apps[0]])).toEqual([
      ['Acme vendor review', 50, 'textedit'],
      ['Zone cost sheet', 60, 'microsoft excel'],
    ]);
    expect(recap.items[0].startTs).toBe(DAY.tasks[0].startTs);
    expect(recap.openLoops).toHaveLength(2);
    expect(recap.basis).toEqual({ tasks: 3, screenReads: 3, speech: 1, activeMinutes: 111 });
    expect(recap.generatedAt).toBe(42);
  });

  it('says there is nothing to recap, without calling the model, when no block is long enough', async () => {
    const { model, calls } = scripted({});
    const recap = await writeRecap({ day: '2026-11-03', tasks: [task('b', 0, 1, ['slack'])] }, [], model);
    expect(calls).toHaveLength(0);
    expect(recap.summary).toContain('Nothing long enough');
    expect(recap.items).toEqual([]);
  });

  it('refuses a reply in the wrong shape', async () => {
    const { model } = scripted({ summary: 'x' });
    await expect(writeRecap(DAY, HITS, model)).rejects.toThrow('wrong shape');
  });
});
