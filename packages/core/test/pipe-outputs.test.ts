import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG, EncryptedStore, TwinAgent, type Pipe, type PipeOutput } from '../src';
import { tempFolders } from './temp-folders';

const temps = tempFolders();
const NOW = Date.UTC(2026, 10, 2, 9, 0);
const MINUTE = 60_000;
const DAY = 86_400_000;
/** Kept run text. The tests check that it is never in a file as plain text, and never in the export. */
const CANARY = 'PIPEOUT_CANARY_6C1F09';
const INVALID_OUTPUT = 'Invalid pipe output: it has a field or value the twin does not accept.';

const writePipe: Pipe = { id: 'write-0001', name: 'Notes', query: '', intervalMinutes: 30, action: 'write', enabled: true };
const otherWritePipe: Pipe = { ...writePipe, id: 'write-0002', name: 'More notes' };
const notifyPipe: Pipe = { id: 'notify-0001', name: 'Standup', query: '', intervalMinutes: 15, action: 'notify', enabled: true };

function output(text: string = CANARY, ranAt: number = NOW): PipeOutput {
  return { ranAt, items: [{ ts: NOW - MINUTE, app: 'Chrome', kind: 'screen', text }] };
}

/** The message of an error thrown by fn, or an empty string when nothing was thrown. */
function messageOf(fn: () => unknown): string {
  try {
    fn();
    return '';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

describe('the encrypted store keeps one run per pipe', () => {
  function openStore(dir: string, key: Buffer): EncryptedStore {
    return temps.track(new EncryptedStore(dir, key));
  }

  it('round-trips a run, and a new run replaces the one before it', () => {
    const dir = temps.folder('pipe-store-');
    const key = randomBytes(32);
    const store = openStore(dir, key);
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: output('first run').items });
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW + 30 * MINUTE, items: [] });
    expect(store.pipeOutputSummary(writePipe.id)).toEqual({ count: 0, ranAt: NOW + 30 * MINUTE });
    expect(store.readAll('pipeOutputs')).toEqual([{ pipeId: writePipe.id, ranAt: NOW + 30 * MINUTE, items: [] }]);
    store.close();

    const reopened = openStore(dir, key);
    expect(reopened.readAll('pipeOutputs')).toHaveLength(1);
    expect(reopened.pipeOutputSummary(writePipe.id)).toEqual({ count: 0, ranAt: NOW + 30 * MINUTE });
  });

  it('keeps each pipe its own record, and reports no run for a pipe with none', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: [] });
    store.replacePipeOutput({ pipeId: otherWritePipe.id, ranAt: NOW, items: [] });
    expect(store.readAll('pipeOutputs')).toHaveLength(2);
    expect(store.pipeOutputSummary('never-run-0')).toBeNull();
  });

  it('keeps the text encrypted in the database file, and the text reads back with the key', () => {
    const dir = temps.folder('pipe-store-');
    const key = randomBytes(32);
    const store = openStore(dir, key);
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: output().items });
    store.close();
    const database = readFileSync(join(dir, 'twin.db'));
    expect(database.length).toBeGreaterThan(0);
    expect(database.includes(CANARY)).toBe(false);
    expect(JSON.stringify(openStore(dir, key).readAll('pipeOutputs'))).toContain(CANARY);
  });

  it('deletes the named pipes only, every pipe with no ids, and nothing for an empty list', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: [] });
    store.replacePipeOutput({ pipeId: otherWritePipe.id, ranAt: NOW, items: [] });
    expect(store.deletePipeOutputs([])).toBe(0);
    expect(store.deletePipeOutputs([writePipe.id])).toBe(1);
    expect(store.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(store.pipeOutputSummary(otherWritePipe.id)).not.toBeNull();
    expect(store.deletePipeOutputs()).toBe(1);
    expect(store.readAll('pipeOutputs')).toEqual([]);
  });

  it('keeps only the pipes it is told to keep, so a pipe that is off or removed keeps no run', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: [] });
    store.replacePipeOutput({ pipeId: otherWritePipe.id, ranAt: NOW, items: [] });
    expect(store.prunePipeOutputs([writePipe.id])).toBe(1);
    expect(store.pipeOutputSummary(otherWritePipe.id)).toBeNull();
    expect(store.prunePipeOutputs([])).toBe(1);
    expect(store.readAll('pipeOutputs')).toEqual([]);
  });

  it('removes the runs older than a cutoff, and keeps a newer one', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW - 91 * DAY, items: [] });
    store.replacePipeOutput({ pipeId: otherWritePipe.id, ranAt: NOW, items: [] });
    expect(store.prunePipeOutputsBefore(NOW - 90 * DAY)).toBe(1);
    expect(store.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(store.pipeOutputSummary(otherWritePipe.id)).toEqual({ count: 0, ranAt: NOW });
  });

  it('drops a match captured before the cutoff from a newer run, and keeps that run with its newer match', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    const older = { ts: NOW - 91 * DAY, app: 'Chrome', kind: 'screen' as const, text: 'OLD_MATCH' };
    const newer = { ts: NOW - MINUTE, app: 'Chrome', kind: 'screen' as const, text: 'NEW_MATCH' };
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: [older, newer] });
    expect(store.prunePipeOutputsBefore(NOW - 90 * DAY)).toBe(0);
    expect(store.pipeOutputSummary(writePipe.id)).toEqual({ count: 1, ranAt: NOW });
    expect(store.readAll('pipeOutputs')).toEqual([{ pipeId: writePipe.id, ranAt: NOW, items: [newer] }]);
  });

  it('removes a newer run whose matches are all past the cutoff, and keeps a run that has no matches', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    const old = { ts: NOW - 91 * DAY, app: 'Chrome', kind: 'screen' as const, text: 'OLD' };
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: [old] });
    store.replacePipeOutput({ pipeId: otherWritePipe.id, ranAt: NOW, items: [] });
    expect(store.prunePipeOutputsBefore(NOW - 90 * DAY)).toBe(1);
    expect(store.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(store.pipeOutputSummary(otherWritePipe.id)).toEqual({ count: 0, ranAt: NOW });
  });

  it('is cleared with the captured text by deleteAllCapture, and refuses a generic write to its collection', () => {
    const store = openStore(temps.folder('pipe-store-'), randomBytes(32));
    store.replacePipeOutput({ pipeId: writePipe.id, ranAt: NOW, items: output().items });
    expect(store.deleteAllCapture()).toEqual({ mediaIds: [] });
    expect(store.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(messageOf(() => store.append('pipeOutputs', output()))).toMatch(/replacePipeOutput/);
    expect(messageOf(() => store.replaceAll('pipeOutputs', [output()]))).toMatch(/replacePipeOutput/);
  });
});

describe('the agent keeps a write pipe run, and removes it on the designed occasions', () => {
  function openAgent(dir: string, key: Buffer, now: number = NOW): TwinAgent {
    return temps.track(new TwinAgent({ dataDir: dir, dataKey: key, now: () => now }));
  }

  function withPipes(pipes: Pipe[]): TwinAgent {
    const agent = openAgent(temps.folder('pipe-agent-'), randomBytes(32));
    agent.updateConfig({ pipes, screenCaptureEnabled: true });
    return agent;
  }

  it('keeps the newest run of a saved, enabled write pipe, and reads back its count and time', () => {
    const agent = withPipes([writePipe]);
    expect(agent.storePipeOutput(writePipe.id, output())).toBe(true);
    expect(agent.pipeOutputSummary(writePipe.id)).toEqual({ count: 1, ranAt: NOW });
    expect(agent.pipeOutputSummary(otherWritePipe.id)).toBeNull();
  });

  it('keeps nothing for a notify pipe, a pipe that is off, or a pipe that is not saved', () => {
    const agent = withPipes([notifyPipe, { ...writePipe, enabled: false }]);
    expect(agent.storePipeOutput(notifyPipe.id, output())).toBe(false);
    expect(agent.storePipeOutput(writePipe.id, output())).toBe(false);
    expect(agent.storePipeOutput(otherWritePipe.id, output())).toBe(false);
    expect(agent.pipeOutputSummary(notifyPipe.id)).toBeNull();
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
  });

  it('refuses an invalid run with one fixed sentence that names no text', () => {
    const agent = withPipes([writePipe]);
    const badKind = { ranAt: NOW, items: [{ ts: NOW, app: null, kind: 'keystroke', text: CANARY }] } as unknown as PipeOutput;
    const tooLong = output('x'.repeat(1001) + CANARY);
    for (const bad of [badKind, tooLong, output(CANARY, -1)]) {
      const message = messageOf(() => agent.storePipeOutput(writePipe.id, bad));
      expect(message).toBe(INVALID_OUTPUT);
      expect(message).not.toContain(CANARY);
    }
    expect(messageOf(() => agent.storePipeOutput('../escape', output()))).toBe(INVALID_OUTPUT);
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
  });

  it('checks the pipe ids it removes, and removes a pipe run by its id', () => {
    const agent = withPipes([writePipe, otherWritePipe]);
    agent.storePipeOutput(writePipe.id, output());
    agent.storePipeOutput(otherWritePipe.id, output());
    expect(messageOf(() => agent.removePipeOutputs(['not a pipe id']))).toBe(INVALID_OUTPUT);
    expect(agent.removePipeOutputs([writePipe.id])).toBe(1);
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(agent.pipeOutputSummary(otherWritePipe.id)).not.toBeNull();
    expect(agent.removePipeOutputs()).toBe(1);
  });

  it('removes a run when its pipe is turned off, and when its pipe is removed from the list', () => {
    const agent = withPipes([writePipe, otherWritePipe]);
    agent.storePipeOutput(writePipe.id, output());
    agent.storePipeOutput(otherWritePipe.id, output());
    agent.updateConfig({ pipes: [{ ...writePipe, enabled: false }, otherWritePipe] });
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
    expect(agent.pipeOutputSummary(otherWritePipe.id)).not.toBeNull();
    agent.updateConfig({ pipes: [] });
    expect(agent.pipeOutputSummary(otherWritePipe.id)).toBeNull();
  });

  it('removes every run when the excluded apps change, and when the excluded window kinds change', () => {
    const agent = withPipes([writePipe]);
    agent.storePipeOutput(writePipe.id, output());
    agent.updateConfig({ excludedApps: [...DEFAULT_CONFIG.excludedApps, 'slack'] });
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
    agent.storePipeOutput(writePipe.id, output());
    agent.updateConfig({ excludedWindowClasses: ['chat'] });
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
  });

  it('removes every run when screen and audio text are deleted', () => {
    const agent = withPipes([writePipe]);
    agent.storePipeOutput(writePipe.id, output());
    agent.deleteAllCapture();
    expect(agent.pipeOutputSummary(writePipe.id)).toBeNull();
  });

  it('removes a run once it is past the retention window, when the twin prunes', () => {
    const dir = temps.folder('pipe-agent-');
    const key = randomBytes(32);
    const first = openAgent(dir, key);
    first.updateConfig({ pipes: [writePipe] });
    first.storePipeOutput(writePipe.id, output());
    first.close();
    const later = openAgent(dir, key, NOW + 91 * DAY);
    expect(later.prune()).toBeGreaterThanOrEqual(1);
    expect(later.pipeOutputSummary(writePipe.id)).toBeNull();
  });

  it('drops a match past the retention window from a kept run when the twin prunes, and keeps the newer match', () => {
    const dir = temps.folder('pipe-agent-');
    const key = randomBytes(32);
    const first = openAgent(dir, key);
    first.updateConfig({ pipes: [writePipe] });
    const later = NOW + 91 * DAY;
    first.storePipeOutput(writePipe.id, {
      ranAt: later - MINUTE,
      items: [
        { ts: NOW - MINUTE, app: 'Chrome', kind: 'screen', text: 'OLD_MATCH' },
        { ts: later - MINUTE, app: 'Chrome', kind: 'screen', text: 'NEW_MATCH' },
      ],
    });
    first.close();
    const restarted = openAgent(dir, key, later);
    restarted.prune();
    expect(restarted.pipeOutputSummary(writePipe.id)).toEqual({ count: 1, ranAt: later - MINUTE });
  });

  it('keeps the run text out of the data export, which holds no kept run', () => {
    const agent = withPipes([writePipe]);
    agent.storePipeOutput(writePipe.id, output());
    expect(JSON.stringify(agent.exportAll())).not.toContain(CANARY);
  });

  it('keeps the run in the encrypted database, with no plain run text on disk, and the run is there after a restart', () => {
    const dir = temps.folder('pipe-agent-');
    const key = randomBytes(32);
    const agent = openAgent(dir, key);
    agent.updateConfig({ pipes: [writePipe] });
    agent.storePipeOutput(writePipe.id, output());
    agent.close();
    const database = readFileSync(join(dir, 'twin.db'));
    expect(database.length).toBeGreaterThan(0);
    expect(database.includes(CANARY)).toBe(false);
    const restarted = openAgent(dir, key);
    expect(restarted.pipeOutputSummary(writePipe.id)).toEqual({ count: 1, ranAt: NOW });
  });
});
