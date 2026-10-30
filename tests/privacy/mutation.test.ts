import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EncryptedStore, TwinAgent, type Automation } from '@companyos/twin-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildOpenMausBotPrompt, runOpenMausBotTask } from '../../apps/desktop/src/main/openmausbot';
import { CANARIES, findLeaks, type Encoding, type Surface } from './canaries';
import { spawnLog } from './fake-spawn';
import { at, runPlantedScenario } from './scenario';
import { ConsoleCapture, diskSurfaces, errorText, recordingFetch } from './surfaces';

// The suite must be able to fail. This file swaps in a deliberately leaking redaction, and it plants a leak on each
// output channel, then checks that the same scanner reports every one of them.
vi.mock('cross-spawn', async () => ({ default: (await import('./fake-spawn')).fakeSpawn }));

vi.mock('../../packages/core/src/redact', async importOriginal => {
  const actual = await importOriginal<typeof import('../../packages/core/src/redact')>();
  // Deliberately leaky. It skips the schema, the secure-input check, the private-window check and the excluded-app list,
  // and it keeps every field the adapter sent: titles, raw URLs and field values all reach the store and the export.
  const leaky = ((input: unknown, options: Parameters<typeof actual.normalizeSignal>[1]) => {
    const signal = input as Record<string, unknown>;
    const kept = actual.normalizeSignal(
      { kind: signal.kind, ts: signal.ts, app: signal.app, url: signal.url },
      { ...options, excludedApps: [] },
    );
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

/** Writes one record and closes the store, so the folder can be removed on Windows. */
function seedStore(storeDir: string, key: Buffer, record: unknown): void {
  const store = new EncryptedStore(storeDir, key);
  try {
    store.append('events', record);
  } finally {
    store.close();
  }
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
    // The canaries on the dropped rows, and the percent-encoded one, must be caught too, or those rows check nothing.
    expect(leaks).toContainEqual({ surface: 'export', canary: 'secureFieldUrl', encoding: 'raw' });
    expect(leaks).toContainEqual({ surface: 'export', canary: 'excludedAppUrl', encoding: 'raw' });
    expect(leaks).toContainEqual({ surface: 'export', canary: 'encodedForms', encoding: 'percent' });
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
    seedStore(storeDir, key, { kind: 'focus', app: 'slack' });
    writeFileSync(join(storeDir, 'debug-dump.txt'), `title ${CANARIES.windowTitle}`);
    expect(caught(diskSurfaces(root, storeDir, key))).toEqual([['store:raw:debug-dump.txt', 'windowTitle', 'raw']]);
  });

  it('a record sealed with the data key, found by decrypting the store', () => {
    const { root, storeDir, key } = freshFolder();
    seedStore(storeDir, key, { kind: 'focus', app: 'slack', title: CANARIES.windowTitle });
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
    agent.close();
  });

  it('the full data export, through a setting that ends up in it', () => {
    const { storeDir, key } = freshFolder();
    const agent = new TwinAgent({ dataDir: storeDir, dataKey: key, now: () => at(0, 12) });
    agent.updateConfig({ openMausBotTarget: CANARIES.routineName });
    expect(caught([{ name: 'export', text: JSON.stringify(agent.exportAll()) }])).toEqual([
      ['export', 'routineName', 'raw'],
    ]);
    agent.close();
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

  it('an outbound model download request carrying a percent-encoded copy', async () => {
    const outbound: string[] = [];
    const fetchImpl = recordingFetch(outbound, () => new Response('', { status: 404 }));
    await fetchImpl(`https://huggingface.co/x?token=${encodeURIComponent(CANARIES.encodedForms)}`, { method: 'GET' });
    expect(caught([{ name: 'outbound:fetch', text: outbound.join('\n') }])).toEqual([
      ['outbound:fetch', 'encodedForms', 'percent'],
    ]);
  });

  it('a plaintext file holding a base64url copy', () => {
    const { root, storeDir, key } = freshFolder();
    seedStore(storeDir, key, { kind: 'focus', app: 'slack' });
    writeFileSync(join(storeDir, 'debug-dump.txt'), Buffer.from(CANARIES.encodedForms).toString('base64url'));
    expect(caught(diskSurfaces(root, storeDir, key))).toEqual([['store:raw:debug-dump.txt', 'encodedForms', 'base64url']]);
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

  it('finds each form of a canary whose five forms all differ', () => {
    const canary = CANARIES.encodedForms;
    const forms: Record<Encoding, string> = {
      raw: canary,
      base64: Buffer.from(canary).toString('base64'),
      base64url: Buffer.from(canary).toString('base64url'),
      hex: Buffer.from(canary).toString('hex'),
      percent: encodeURIComponent(canary),
    };
    expect(new Set(Object.values(forms)).size).toBe(5);
    for (const [encoding, text] of Object.entries(forms)) {
      expect(findLeaks([{ name: 'surface', text }])).toEqual([{ surface: 'surface', canary: 'encodedForms', encoding }]);
    }
  });

  // Each byte before the copy moves it to another place inside a 3-byte base64 group. The copy is followed by more bytes,
  // so the last character of its own encoding is not the one a longer stream would show.
  it.each([0, 1, 2])('finds base64 and base64url copies that start at byte %i of a longer stream', shift => {
    const stream = Buffer.concat([Buffer.alloc(shift, 'x'), Buffer.from(`${CANARIES.encodedForms} and more`)]);
    expect(findLeaks([{ name: 'store:decoded:events.log', text: stream.toString('base64') }])).toContainEqual({
      surface: 'store:decoded:events.log',
      canary: 'encodedForms',
      encoding: 'base64',
    });
    expect(findLeaks([{ name: 'store:decoded:events.log', text: stream.toString('base64url') }])).toContainEqual({
      surface: 'store:decoded:events.log',
      canary: 'encodedForms',
      encoding: 'base64url',
    });
  });
});
