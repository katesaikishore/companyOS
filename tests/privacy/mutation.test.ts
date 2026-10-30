import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, TwinAgent, type Automation } from '@companyos/twin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpenMausBotPrompt, runOpenMausBotTask } from '../../apps/desktop/src/main/openmausbot';
import { CANARIES, findLeaks, type Surface } from './canaries';
import { spawnLog } from './fake-spawn';
import { at, runPlantedScenario } from './scenario';
import { ConsoleCapture, diskSurfaces, errorText, recordingFetch } from './surfaces';

// The suite must be able to fail. This file swaps in a deliberately leaking redaction, and it plants a leak on each
// output channel, then checks that the same scanner reports every one of them.
vi.mock('cross-spawn', async () => ({ default: (await import('./fake-spawn')).fakeSpawn }));

vi.mock('../../packages/core/src/redact', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/core/src/redact')>();
  // Deliberately leaky. It skips the schema, the secure-input check and the private-window check, and it keeps every
  // field the adapter sent: titles, raw URLs and field values all reach the store and the export.
  const leaky = ((input: unknown, options: Parameters<typeof actual.normalizeSignal>[1]) => {
    const signal = input as Record<string, unknown>;
    const kept = actual.normalizeSignal({ kind: signal.kind, ts: signal.ts, app: signal.app, url: signal.url }, options);
    return kept === null ? null : { ...kept, ...signal };
  }) as typeof actual.normalizeSignal;
  return { ...actual, normalizeSignal: leaky };
});

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function freshFolder(): { root: string; storeDir: string; key: Buffer } {
  const root = mkdtempSync(join(tmpdir(), 'twin-privacy-channel-'));
  roots.push(root);
  return { root, storeDir: join(root, 'twin'), key: randomBytes(32) };
}

function automationNamed(name: string): Automation {
  return {
    id: 'auto_channel',
    name,
    version: 1,
    routineId: 'routine_channel',
    params: [],
    steps: [
      { op: 'focus_app', app: 'Slack' },
      { op: 'check_focus', app: 'Slack' },
    ],
  };
}

function caught(surfaces: readonly Surface[]): Array<[string, string, string]> {
  return findLeaks(surfaces).map(leak => [leak.surface, leak.canary, leak.encoding]);
}

describe('a leaking redaction is caught', () => {
  it('titles, raw URLs and field values kept by a leaky normalizer reach the store and the export', async () => {
    const run = await runPlantedScenario();
    const leaks = findLeaks(run.surfaces);

    expect(run.outcomes['window title in a title key']).toBe('stored');
    expect(leaks).toContainEqual({ surface: 'store:decrypted:events', canary: 'windowTitle', encoding: 'raw' });
    expect(leaks).toContainEqual({ surface: 'export', canary: 'urlQuery', encoding: 'raw' });
    expect(leaks.some(leak => leak.canary === 'secureFieldValue')).toBe(true);
  }, 60_000);
});

describe('each output channel is scanned, so a leak planted on it is caught', () => {
  it('console output', () => {
    const capture = new ConsoleCapture();
    console.log('debug', CANARIES.windowTitle);
    const text = capture.text();
    capture.restore();
    expect(caught([{ name: 'console', text }])).toEqual([['console', 'windowTitle', 'raw']]);
  });

  it('a plaintext file beside the encrypted store', () => {
    const { root, storeDir, key } = freshFolder();
    new EncryptedStore(storeDir, key).append('events', { kind: 'focus', app: 'slack' });
    writeFileSync(join(storeDir, 'debug-dump.txt'), `title ${CANARIES.windowTitle}`);
    expect(caught(diskSurfaces(root, storeDir, key))).toEqual([['store:raw:debug-dump.txt', 'windowTitle', 'raw']]);
  });

  it('a record sealed with the data key, found by decrypting the store', () => {
    const { root, storeDir, key } = freshFolder();
    new EncryptedStore(storeDir, key).append('events', { kind: 'focus', app: 'slack', title: CANARIES.windowTitle });
    expect(caught(diskSurfaces(root, storeDir, key))).toEqual([['store:decrypted:events', 'windowTitle', 'raw']]);
  });

  it('a thrown error message', () => {
    const error = new Error(`could not read ${CANARIES.fieldValue}`);
    expect(caught([{ name: 'errors', text: errorText(error) }])).toEqual([['errors', 'fieldValue', 'raw']]);
  });

  it('the network ledger', () => {
    const { storeDir, key } = freshFolder();
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => at(0, 12) });
    agent.recordNetworkCall({
      ts: at(0, 12),
      purpose: 'model_download',
      modelId: 'qwen3-0.6b',
      host: 'huggingface.co',
      path: `/x?sig=${CANARIES.urlQuery}`,
      bytes: 0,
      sha256Verified: false,
      outcome: 'failed',
    });
    expect(caught([{ name: 'ledger', text: JSON.stringify(agent.networkLedger()) }])).toEqual([
      ['ledger', 'urlQuery', 'raw'],
    ]);
  });

  it('the full data export, through a setting that ends up in it', () => {
    const { storeDir, key } = freshFolder();
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => at(0, 12) });
    agent.updateConfig({ openMausBotTarget: CANARIES.routineName });
    expect(caught([{ name: 'export', text: JSON.stringify(agent.exportAll()) }])).toEqual([
      ['export', 'routineName', 'raw'],
    ]);
  });

  it('the OpenMausBot prompt preview', () => {
    const prompt = buildOpenMausBotPrompt(automationNamed(CANARIES.routineName), 'Summarise the follow-ups');
    expect(caught([{ name: 'prompt:openmausbot', text: prompt }])).toEqual([
      ['prompt:openmausbot', 'routineName', 'raw'],
    ]);
  });

  it('an outbound model download request', async () => {
    const outbound: string[] = [];
    const fetchImpl = recordingFetch(outbound, () => new Response('', { status: 404 }));
    await fetchImpl(`https://huggingface.co/x?token=${CANARIES.urlQuery}`, { method: 'GET' });
    expect(caught([{ name: 'outbound:fetch', text: outbound.join('\n') }])).toEqual([
      ['outbound:fetch', 'urlQuery', 'raw'],
    ]);
  });

  it('outbound OpenMausBot command-line arguments', async () => {
    spawnLog.length = 0;
    await runOpenMausBotTask({
      command: 'openmausbot',
      target: 'Lead Bot',
      automation: automationNamed(CANARIES.routineName),
      taskBrief: 'Summarise the follow-ups',
    });
    const text = spawnLog.map(call => [call.command, ...call.args].join('\n')).join('\n---\n');
    expect(caught([{ name: 'outbound:spawn', text }])).toEqual([['outbound:spawn', 'routineName', 'raw']]);
  });
});

describe('the scanner matches copies in other forms', () => {
  it('finds base64, hex and lower-cased copies', () => {
    const base64 = Buffer.from(CANARIES.clipboard).toString('base64');
    const hex = Buffer.from(CANARIES.clipboard).toString('hex');
    const lower = CANARIES.clipboard.toLowerCase();
    const encodings = findLeaks([{ name: 'store:decoded:events.log', text: `${base64}\n${hex}\n${lower}` }]).map(
      leak => leak.encoding,
    );
    expect(encodings.sort()).toEqual(['base64', 'hex', 'raw']);
  });
});
