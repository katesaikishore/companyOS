import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { DiscordMessage } from '@companyos/twin-core';
import { DiscordReader, type Exec } from '../src/main/discord-reader';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const TREE = {
  role: 'window',
  children: [
    {
      role: 'list',
      name: 'Messages in Kala',
      children: [
        { role: 'article', name: 'Kala , Hii anna , Yesterday at 6:23 PM', children: [{ role: 'statictext', name: 'Monday, November 2, 2026 at 6:23 PM' }] },
        { role: 'article', name: 'Kala , Standup at 11 , 6:24 PM', children: [{ role: 'statictext', name: 'Monday, November 2, 2026 at 6:24 PM' }] },
      ],
    },
  ],
};

/** A stand-in for agent-desktop: one Discord window, its tree, and every call recorded. */
function fakeProgram(windows: unknown[] = [{ id: 'w-80', title: '@Kala - Discord' }]) {
  const calls: string[][] = [];
  const exec: Exec = async (_binary, args) => {
    calls.push([...args]);
    if (args[0] === 'list-windows') return JSON.stringify({ ok: true, data: windows });
    if (args[0] === 'snapshot') return JSON.stringify({ ok: true, data: { tree: TREE } });
    return JSON.stringify({ ok: false });
  };
  return { exec, calls };
}

function reader(options: { allowed?: () => boolean; exec: Exec; stored: DiscordMessage[]; seenFile?: string; binary?: string }) {
  const dir = mkdtempSync(join(tmpdir(), 'discord-reader-'));
  dirs.push(dir);
  return new DiscordReader({
    binary: () => options.binary ?? '/bin/agent-desktop',
    allowed: options.allowed ?? (() => true),
    store: message => (options.stored.push(message), true),
    seenFile: options.seenFile ?? join(dir, 'seen.json'),
    exec: options.exec,
  });
}

describe('DiscordReader', () => {
  it('reads each Discord window with list-windows and snapshot only, and stores each message once', async () => {
    const stored: DiscordMessage[] = [];
    const { exec, calls } = fakeProgram();
    const r = reader({ exec, stored });
    expect(await r.readNow()).toBe(2);
    expect(await r.readNow()).toBe(0);
    expect(stored.map(m => m.text)).toEqual(['Hii anna', 'Standup at 11']);
    expect(new Set(calls.map(call => call[0]))).toEqual(new Set(['list-windows', 'snapshot']));
  });

  it('remembers what it stored across a restart, as hashes only', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'discord-seen-'));
    dirs.push(dir);
    const seenFile = join(dir, 'seen.json');
    const first: DiscordMessage[] = [];
    await reader({ exec: fakeProgram().exec, stored: first, seenFile }).readNow();
    const again: DiscordMessage[] = [];
    expect(await reader({ exec: fakeProgram().exec, stored: again, seenFile }).readNow()).toBe(0);
    const saved = readFileSync(seenFile, 'utf8');
    expect(saved).not.toContain('Hii anna');
    expect(JSON.parse(saved)).toHaveLength(2);
  });

  it('reads nothing when capture does not allow it, and says why when it cannot read', async () => {
    const stored: DiscordMessage[] = [];
    const off = fakeProgram();
    expect(await reader({ exec: off.exec, stored, allowed: () => false }).readNow()).toBe(0);
    expect(off.calls).toHaveLength(0);
    const unset = reader({ exec: fakeProgram().exec, stored, binary: '' });
    await unset.readNow();
    expect(unset.state.problem).toBe('not_set');
    const closed = reader({ exec: fakeProgram([]).exec, stored });
    await closed.readNow();
    expect(closed.state.problem).toBe('not_running');
    expect(stored).toHaveLength(0);
  });

  it('forgets what it stored, so the messages can be stored again after captured text is deleted', async () => {
    const stored: DiscordMessage[] = [];
    const r = reader({ exec: fakeProgram().exec, stored });
    await r.readNow();
    r.forget();
    expect(await r.readNow()).toBe(2);
  });
});
