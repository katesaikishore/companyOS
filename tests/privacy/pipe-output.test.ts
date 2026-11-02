import { TwinAgent, type Pipe, type PipeGate } from '@companyos/twin-core';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PipeScheduler } from '../../apps/desktop/src/main/pipes';
import { CANARIES, findLeaks } from './canaries';
import { diskSurfaces } from './surfaces';

// Pipe output is stored text. It is kept encrypted in the store, and it must not reach the console, a notice or the export,
// nor any file on disk in plain form. The canary is planted as captured screen text, so a pipe run copies it into the kept run.
const CANARY = CANARIES.pipeOutput;
const START = Date.UTC(2026, 10, 2, 9, 0);
const MINUTE = 60_000;
const OPEN: PipeGate = { automationsEnabled: true, paused: false, locked: false, idle: false, secureInput: false };
const write: Pipe = { id: 'write-0001', name: 'Notes', query: '', intervalMinutes: 30, action: 'write', enabled: true };
const notify: Pipe = { id: 'notify-0001', name: 'Standup', query: '', intervalMinutes: 15, action: 'notify', enabled: true };

const CONSOLE_METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;

/** Records everything the console is given while fn runs, and restores the console after. */
function recordConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = CONSOLE_METHODS.map(method =>
    vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(arg => (typeof arg === 'string' ? arg : JSON.stringify(arg) ?? String(arg))).join(' '));
    }),
  );
  return { lines, restore: () => spies.forEach(spy => spy.mockRestore()) };
}

const folders: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('pipe output text stays out of the console, the notices and the export', () => {
  it('a run keeps its text in the store, and no console line, notice, export or file on disk carries it', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'privacy-pipe-output-'));
    folders.push(dir);
    let now = START;
    const storeDir = join(dir, 'twin');
    const key = randomBytes(32);
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => now });
    const notices: string[] = [];
    const recorded = recordConsole();
    try {
      agent.updateConfig({ pipes: [write, notify], screenCaptureEnabled: true });
      agent.ingestScreen({ ts: START + 5 * MINUTE, app: 'Pages', windowClass: 'document', text: `${CANARY} budget review`, mediaId: null });
      const scheduler = new PipeScheduler({
        now: () => now,
        pipes: () => agent.configuration.pipes,
        gate: async () => OPEN,
        search: request => agent.searchCapture(request),
        notify: text => notices.push(text),
        storeOutput: (pipeId, output) => {
          agent.storePipeOutput(pipeId, output);
        },
      });
      await scheduler.tick();
      now += 30 * MINUTE;
      await scheduler.tick();

      // The run happened: the text is kept, and the notice was shown. So the checks below are not empty passes.
      expect(agent.pipeOutputSummary(write.id)).toEqual({ count: 1, ranAt: now });
      expect(notices).toEqual(['Standup: 1 new match in pages.']);
      expect(JSON.stringify(agent.exportAll())).not.toContain(CANARY);

      // On disk, the run is sealed. Every raw and decoded file is checked, and the decrypted surfaces are left out, since they
      // are what the store's own key opens. The decrypted pipe outputs must hold the match, so this check is not an empty pass.
      const disk = diskSurfaces(dir, storeDir, key);
      const onDisk = disk.filter(surface => !surface.name.startsWith('store:decrypted:') && !surface.name.startsWith('media:decrypted:'));
      expect(onDisk.length).toBeGreaterThan(0);
      expect(findLeaks(onDisk)).toEqual([]);
      expect(disk.find(surface => surface.name === 'store:decrypted:pipeOutputs')?.text ?? '').toContain(CANARY);
    } finally {
      recorded.restore();
      agent.close();
    }
    expect(notices.join('\n')).not.toContain(CANARY);
    expect(recorded.lines.join('\n')).not.toContain(CANARY);
  });

  it('a store that refuses a run reports a fixed sentence, and the error text stays out of the console', async () => {
    const recorded = recordConsole();
    try {
      let now = START;
      const scheduler = new PipeScheduler({
        now: () => now,
        pipes: () => [write],
        gate: async () => OPEN,
        search: () => [{ kind: 'screen', id: 'c'.repeat(32), ts: START, app: 'Pages', snippet: CANARY }],
        notify: () => undefined,
        storeOutput: () => {
          throw new Error(`refused the run ${CANARY}`);
        },
      });
      await scheduler.tick();
      now += 30 * MINUTE;
      await scheduler.tick();
    } finally {
      recorded.restore();
    }
    expect(recorded.lines).toEqual(['A pipe did not run. Its text is not logged.']);
  });
});
