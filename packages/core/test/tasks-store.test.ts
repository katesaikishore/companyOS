import { randomBytes } from 'node:crypto';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EncryptedStore, RETENTION_DAYS, TwinAgent, dayKeyOf, type DayTasksView, type TaskDecision } from '../src';
import { at } from './fixtures';

const DAY_MS = 86_400_000;
const DAY = dayKeyOf(at(0, 12));

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), 'twin-tasks-'));
}

function openAgent(dir: string, key: Buffer, now = at(0, 12)): TwinAgent {
  return new TwinAgent({ dataDir: dir, dataKey: key, now: () => now });
}

/** A morning in Excel, a break, then Slack, then Outlook after an hour away: three tasks, none sharing an app. */
function seedMorning(agent: TwinAgent): void {
  agent.ingest({ kind: 'focus', ts: at(0, 9), app: 'Microsoft Excel' });
  agent.ingest({ kind: 'focus', ts: at(0, 9, 10), app: 'Microsoft Excel' });
  agent.ingest({ kind: 'idle_start', ts: at(0, 9, 12) });
  agent.ingest({ kind: 'idle_end', ts: at(0, 9, 14) });
  agent.ingest({ kind: 'focus', ts: at(0, 9, 20), app: 'Slack' });
  agent.ingest({ kind: 'idle_start', ts: at(0, 9, 35) });
  agent.ingest({ kind: 'focus', ts: at(0, 10, 30), app: 'Microsoft Outlook' });
}

function tasksOf(agent: TwinAgent, day = DAY): DayTasksView {
  return agent.dayTasks(day);
}

function exported(agent: TwinAgent): { taskDecisions: TaskDecision[] } {
  return agent.exportAll() as { taskDecisions: TaskDecision[] };
}

describe('task decisions in the encrypted store', () => {
  it('keeps the decisions across a reopen with the same key', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    seedMorning(agent);
    const [excel, slack] = tasksOf(agent).tasks;
    agent.decideTask({ day: DAY, kind: 'rename', taskId: excel.id, name: 'Budget' });
    agent.decideTask({ day: DAY, kind: 'confirm', taskId: slack.id });
    agent.close();

    const reopened = openAgent(dir, key);
    expect(tasksOf(reopened).tasks.map(task => [task.name, task.confirmed])).toEqual([
      ['Budget', true],
      ['Slack', true],
      ['Microsoft Outlook', false],
    ]);
    reopened.close();
  });

  it('exports a rename with a placeholder for the typed name, and keeps the name for the person', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    seedMorning(agent);
    const excel = tasksOf(agent).tasks[0];
    agent.decideTask({ day: DAY, kind: 'rename', taskId: excel.id, name: 'Budget' });
    expect(exported(agent).taskDecisions).toEqual([{ day: DAY, kind: 'rename', taskId: excel.id, name: expect.any(String) }]);
    expect(JSON.stringify(agent.exportAll())).not.toContain('Budget');
    expect(tasksOf(agent).tasks[0]).toMatchObject({ name: 'Budget', renamed: true });
    agent.close();

    const reopened = openAgent(dir, key);
    expect(tasksOf(reopened).tasks[0]).toMatchObject({ name: 'Budget', renamed: true });
    expect(JSON.stringify(reopened.exportAll())).not.toContain('Budget');
    reopened.close();
  });

  it('exports a cleared rename as it is, since a cleared name holds no typed text', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    seedMorning(agent);
    const excel = tasksOf(agent).tasks[0];
    agent.decideTask({ day: DAY, kind: 'rename', taskId: excel.id, name: 'Budget' });
    agent.decideTask({ day: DAY, kind: 'rename', taskId: excel.id, name: '' });
    const [typed, cleared] = exported(agent).taskDecisions;
    expect(JSON.stringify(typed)).not.toContain('Budget');
    expect(cleared).toEqual({ day: DAY, kind: 'rename', taskId: excel.id, name: '' });
    agent.close();
  });

  it('is removed by Delete everything, so a new store under the same key starts with the rule-based names', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    seedMorning(agent);
    agent.decideTask({ day: DAY, kind: 'rename', taskId: tasksOf(agent).tasks[0].id, name: 'Budget' });
    agent.wipe();
    expect(existsSync(join(dir, 'twin.db'))).toBe(false);

    const after = openAgent(dir, key);
    expect(exported(after).taskDecisions).toEqual([]);
    seedMorning(after);
    expect(tasksOf(after).tasks.map(task => [task.name, task.confirmed])).toEqual([
      ['Microsoft Excel', false],
      ['Slack', false],
      ['Microsoft Outlook', false],
    ]);
    after.close();
  });

  it('includes every decision in the data export, as ids and the action only', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    seedMorning(agent);
    const [excel] = tasksOf(agent).tasks;
    agent.decideTask({ day: DAY, kind: 'confirm', taskId: excel.id });

    expect(exported(agent).taskDecisions).toEqual([{ day: DAY, kind: 'confirm', taskId: excel.id }]);
    expect(JSON.stringify(exported(agent).taskDecisions)).not.toMatch(/excel|slack|outlook/i);
    agent.close();
  });

  it('refuses a decision that no longer fits the day, and stores nothing', () => {
    const agent = openAgent(freshDir(), randomBytes(32));
    seedMorning(agent);

    expect(() => agent.decideTask({ day: DAY, kind: 'confirm', taskId: 'nothere-9' })).toThrow('no longer fits');
    expect(() => agent.decideTask({ day: DAY, kind: 'confirm', title: 'Quarterly plan' })).toThrow('not valid');
    expect(exported(agent).taskDecisions).toEqual([]);
    agent.close();
  });

  it('removes decisions with the events of their day, once the retention window has passed', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const first = openAgent(dir, key);
    seedMorning(first);
    first.decideTask({ day: DAY, kind: 'confirm', taskId: tasksOf(first).tasks[0].id });
    first.close();

    const later = openAgent(dir, key, at(0, 12) + (RETENTION_DAYS + 1) * DAY_MS);
    expect(later.prune()).toBeGreaterThan(0);
    expect(exported(later).taskDecisions).toEqual([]);
    later.close();
  });

  it('leaves out a stored decision that does not parse, and still builds the day', () => {
    const dir = freshDir();
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    seedMorning(agent);
    agent.close();

    const raw = new EncryptedStore(dir, key);
    raw.append('taskDecisions', { day: DAY, kind: 'confirm', taskId: 'nothere-9', title: 'not a field the twin keeps' });
    raw.close();

    const reopened = openAgent(dir, key);
    expect(exported(reopened).taskDecisions).toEqual([]);
    expect(tasksOf(reopened).tasks).toHaveLength(3);
    reopened.close();
  });
});
