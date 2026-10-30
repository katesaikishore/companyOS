import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore, INTERRUPTED_HANDOFF_SUMMARY, TwinAgent, type HandoffView } from '../src';

const CANARY = 'handoff-canary-4417';
const REPLY_CANARY = 'reply-canary-8820';
const TREE_CANARY = 'tree-canary-1139';

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'twin-handoff-'));
}

function openAgent(dir: string, key: Buffer): TwinAgent {
  return new TwinAgent({ dataDir: dir, dataKey: key, now: () => 1_000_000 });
}

function handoff(overrides: Partial<HandoffView> = {}): HandoffView {
  return {
    id: 'handoff-1',
    automationId: 'auto_0123456789ab',
    routineName: 'Invoice follow-up',
    target: 'Lead Bot',
    brief: `Summarise the follow-ups ${CANARY}`,
    apps: ['Microsoft Excel', 'Slack'],
    cadencePerWeek: 3,
    sentAt: 1_000,
    state: 'sending',
    summary: '',
    localFailure: false,
    ...overrides,
  };
}

/** Every byte the store keeps on disk: the database, its write-ahead log and its shared-memory index. */
function rawBytes(dir: string): Buffer {
  return Buffer.concat(readdirSync(dir).map(name => readFileSync(join(dir, name))));
}

describe('handoffs in the encrypted store', () => {
  it('replaces a handoff with the same id in place, so the first write is not kept alongside', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    agent.recordHandoff(handoff());
    agent.recordHandoff(handoff({ state: 'completed', summary: `Reply ${REPLY_CANARY}`, threadId: 'th_8f2c1', taskTree: '{"id":"root"}' }));
    const stored = agent.handoffs();
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ id: 'handoff-1', state: 'completed', threadId: 'th_8f2c1', sentAt: 1_000 });
    agent.close();
  });

  it('returns the newest first, breaks a tie on send time by the later write, and never returns more than 100', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    for (let index = 0; index < 120; index++) agent.recordHandoff(handoff({ id: `h${index}`, sentAt: 1_000 + index }));
    agent.recordHandoff(handoff({ id: 'same-time-later', sentAt: 1_119 }));
    const all = agent.handoffs();
    expect(all).toHaveLength(100);
    expect(all[0].id).toBe('same-time-later');
    expect(all[1].id).toBe('h119');
    expect(all[99].id).toBe('h21');
    expect(agent.handoffs(2).map(item => item.id)).toEqual(['same-time-later', 'h119']);
    expect(agent.handoffs(1_000)).toHaveLength(100);
    expect(agent.handoffs(0)).toEqual([]);
    agent.close();
  });

  it('keeps handoffs across a reopen with the same key', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    agent.recordHandoff(handoff());
    agent.close();
    const reopened = openAgent(dir, key);
    expect(reopened.handoffs()).toEqual([handoff()]);
    reopened.close();
  });

  it('stores handoffs encrypted: no brief, reply or task tree appears in the files on disk', () => {
    const dir = freshDir();
    const agent = openAgent(dir, randomBytes(32));
    agent.recordHandoff(
      handoff({ state: 'completed', summary: `Reply ${REPLY_CANARY}`, threadId: 'th_1', taskTree: JSON.stringify({ title: TREE_CANARY }) }),
    );
    // The canaries are readable through the agent, so the checks below cannot pass by accident.
    expect(JSON.stringify(agent.handoffs())).toContain(CANARY);
    const openBytes = rawBytes(dir);
    for (const canary of [CANARY, REPLY_CANARY, TREE_CANARY]) expect(openBytes.includes(canary)).toBe(false);
    expect(openBytes.subarray(0, 15).toString('latin1')).not.toBe('SQLite format 3');
    agent.close();
    const closedBytes = rawBytes(dir);
    for (const canary of [CANARY, REPLY_CANARY, TREE_CANARY]) expect(closedBytes.includes(canary)).toBe(false);
  });

  it('includes every stored handoff in the data export', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    for (let index = 0; index < 101; index++) agent.recordHandoff(handoff({ id: `h${index}`, sentAt: 1_000 + index }));
    const exported = agent.exportAll() as { handoffs: HandoffView[] };
    expect(exported.handoffs).toHaveLength(101);
    expect(exported.handoffs.map(item => item.id)).toContain('h0');
    agent.recordHandoff(handoff({ summary: `Reply ${REPLY_CANARY}` }));
    expect(JSON.stringify(agent.exportAll())).toContain(REPLY_CANARY);
    agent.close();
  });

  it('is removed by Delete everything, and a new store under the same key starts empty', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    agent.recordHandoff(handoff());
    agent.wipe();
    expect(existsSync(join(dir, 'twin.db'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
    const after = openAgent(dir, key);
    expect(after.handoffs()).toEqual([]);
    after.close();
  });

  it('closes a handoff still sending when the app starts, and leaves finished ones as they were', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    agent.recordHandoff(handoff({ id: 'cut-off', state: 'sending' }));
    agent.recordHandoff(handoff({ id: 'finished', sentAt: 2_000, state: 'completed', summary: 'Done.', threadId: 'th_2' }));
    expect(agent.closeInterruptedHandoffs()).toBe(1);
    const byId = new Map(agent.handoffs().map(item => [item.id, item]));
    expect(byId.get('cut-off')).toMatchObject({ state: 'failed', summary: INTERRUPTED_HANDOFF_SUMMARY, localFailure: true });
    expect(byId.get('finished')).toMatchObject({ state: 'completed', summary: 'Done.', threadId: 'th_2', localFailure: false });
    expect(agent.closeInterruptedHandoffs()).toBe(0);
    agent.close();
  });

  it('refuses a record that breaks the schema, and stores nothing from it', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    expect(() => agent.recordHandoff({ ...handoff(), state: 'bogus' } as unknown as HandoffView)).toThrow();
    expect(() => agent.recordHandoff({ ...handoff(), unexpected: 'field' } as unknown as HandoffView)).toThrow();
    expect(() => agent.recordHandoff(handoff({ summary: 'x'.repeat(8_001) }))).toThrow();
    expect(agent.handoffs()).toEqual([]);
    agent.close();
  });

  it('leaves out a stored record that no longer fits the schema, and keeps the rest readable', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    agent.recordHandoff(handoff({ id: 'good' }));
    agent.close();
    const raw = new EncryptedStore(dir, key);
    raw.append('handoffs', { id: 'bad', state: 'not-a-state' });
    raw.close();
    const reopened = openAgent(dir, key);
    expect(reopened.handoffs().map(item => item.id)).toEqual(['good']);
    reopened.close();
  });
});
