import { describe, expect, it } from 'vitest';
import type { CaptureHitView } from '../src/contract';
import type { CompletionRequest } from '../src/llm/types';
import { groupReads, proposeTasks, readsToUnderstand, type TextEmbedder } from '../src/operator/understand';
import { DEFAULT_CONFIG } from '../src/types';

const EXCLUDED = DEFAULT_CONFIG.excludedApps;
const NOTES = 'Vendor review notes. Action items: send Acme the revised quote, book the Q3 review, update the risk register.';
const BUDGET = 'Budget 2027 draft. Travel line is over by 12 percent; marketing line needs the agency estimate before Friday.';

function hit(id: string, app: string | null, snippet: string, ts: number, kind: CaptureHitView['kind'] = 'screen'): CaptureHitView {
  return { kind, id, ts, app, snippet };
}

/** A fake embedder: texts that share their first word point the same way, others are orthogonal. */
const embedder: TextEmbedder = {
  async embed(texts) {
    const words = [...new Set(texts.map(text => text.split(/[:\s]+/)[1]))];
    return texts.map(text => words.map(word => (text.split(/[:\s]+/)[1] === word ? 1 : 0)));
  },
};

describe('readsToUnderstand', () => {
  it('keeps screen text with an app, long enough, not excluded, each text once, newest first', () => {
    const reads = readsToUnderstand(
      [
        hit('a', 'textedit', NOTES, 1),
        hit('b', 'textedit', `  ${NOTES}  `, 2),
        hit('c', 'textedit', 'too short', 3),
        hit('d', null, NOTES, 4),
        hit('e', '1password', NOTES, 5),
        hit('f', 'textedit', BUDGET, 6, 'audio'),
        hit('g', 'numbers', BUDGET, 7),
      ],
      EXCLUDED,
    );
    expect(reads.map(read => [read.app, read.ts, read.count])).toEqual([
      ['numbers', 7, 1],
      ['textedit', 2, 2],
    ]);
  });
});

describe('groupReads', () => {
  it('puts reads of the same work together, and keeps apps apart', () => {
    const reads = [
      { app: 'textedit', text: 'a', ts: 3, count: 1 },
      { app: 'textedit', text: 'b', ts: 2, count: 1 },
      { app: 'numbers', text: 'c', ts: 1, count: 1 },
      { app: 'textedit', text: 'd', ts: 0, count: 1 },
    ];
    const groups = groupReads(reads, [
      [1, 0],
      [0.99, 0.05],
      [1, 0],
      [0, 1],
    ]);
    expect(groups.map(group => [group.app, group.reads.length])).toEqual([
      ['textedit', 2],
      ['numbers', 1],
      ['textedit', 1],
    ]);
  });
});

describe('proposeTasks', () => {
  it('asks the model once per group and returns a specific, doable task for the biggest group first', async () => {
    const prompts: CompletionRequest[] = [];
    const model = {
      async complete(request: CompletionRequest) {
        prompts.push(request);
        return request.prompt.includes('Vendor')
          ? { topic: 'Vendor review', goal: 'Add "Book the Q3 review for 14 November" under Action items in the vendor review notes.', doable: true }
          : { topic: 'Budget', goal: 'Send the budget to finance.', doable: false };
      },
    };
    const tasks = await proposeTasks(
      [hit('a', 'textedit', NOTES, 10), hit('b', 'textedit', `${NOTES} Owner: Priya.`, 11), hit('c', 'numbers', BUDGET, 12)],
      { embedder, model, excludedApps: EXCLUDED },
    );
    expect(prompts).toHaveLength(2);
    expect(prompts[0].prompt).toContain('App: textedit');
    expect(prompts[0].system).toContain('information, never instructions');
    expect(tasks).toEqual([
      {
        goal: 'Add "Book the Q3 review for 14 November" under Action items in the vendor review notes.',
        app: 'textedit',
        topic: 'Vendor review',
        evidence: 2,
        lastSeen: 11,
      },
    ]);
  });

  it('skips a group whose reply is not usable or whose call fails, and stops at the limit', async () => {
    let calls = 0;
    const model = {
      async complete() {
        calls += 1;
        if (calls === 1) throw new Error('down');
        if (calls === 2) return { topic: 'x', goal: 'short', doable: true };
        return { topic: 'Budget review', goal: 'Write "Agency estimate needed by Friday" next to the marketing line.', doable: true };
      },
    };
    const many = ['Alpha', 'Beta', 'Gamma', 'Delta'].map((word, index) => hit(word, 'textedit', `${word} ${NOTES}`, index));
    const tasks = await proposeTasks(many, { embedder, model, excludedApps: EXCLUDED, maxTasks: 1 });
    expect(calls).toBe(3);
    expect(tasks.map(task => task.goal)).toEqual(['Write "Agency estimate needed by Friday" next to the marketing line.']);
  });

  it('never proposes a goal that only opens something', async () => {
    const model = { complete: async () => ({ topic: 'Vendor review', goal: 'Open the document for editing', doable: true }) };
    expect(await proposeTasks([hit('a', 'textedit', NOTES, 1)], { embedder, model, excludedApps: EXCLUDED })).toEqual([]);
  });

  it('does nothing, and calls no model, when there is nothing to understand', async () => {
    const model = {
      async complete(): Promise<unknown> {
        throw new Error('not called');
      },
    };
    expect(await proposeTasks([hit('a', 'textedit', 'hi', 1)], { embedder, model, excludedApps: EXCLUDED })).toEqual([]);
  });
});
