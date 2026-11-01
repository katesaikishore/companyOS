import { TwinAgent, dayKeyOf, templateUrl } from '@companyos/twin-core';
import childProcess from 'node:child_process';
import { randomBytes } from 'node:crypto';
import https from 'node:https';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { CANARIES, findLeaks, describeLeak, type Surface } from './canaries';
import { PLANTED, at, runPlantedScenario, type ScenarioRun } from './scenario';
import { refuseOutbound } from './surfaces';

// The model manager imports Electron's utility process. The suite never forks a model, so a stand-in is enough.
vi.mock('electron', () => ({
  utilityProcess: {
    fork: () => {
      throw new Error('The privacy suite does not start a model worker.');
    },
  },
}));

let run: ScenarioRun;

beforeAll(async () => {
  run = await runPlantedScenario();
}, 60_000);

/** Fails with every leak found on the surfaces that match. A surface that matches nothing fails too, so a pass is never empty. */
function expectNoLeaks(surfaces: readonly Surface[], select: (name: string) => boolean): void {
  const selected = surfaces.filter(surface => select(surface.name));
  expect(selected.length, 'no surface matched, so nothing was checked').toBeGreaterThan(0);
  expect(findLeaks(selected).map(describeLeak)).toEqual([]);
}

describe('the planted inputs reach the pipeline and take the designed path', () => {
  it('rejects, drops or stores each ingest surface as designed', () => {
    expect(run.outcomes).toEqual(Object.fromEntries(PLANTED.map(planted => [planted.label, planted.outcome])));
  });

  it('keeps only the template of a URL that carries a query and a fragment', () => {
    expect(run.facts.chromeTemplate).toBe('docs.example.com/doc');
  });

  it('records the model download in the ledger', () => {
    expect(run.facts.ledgerEntries).toBe(1);
    expect(run.facts.downloadStatus).toEqual(['failed']);
  });

  // The suite plans no process call, so any child process the app starts is refused and counted here.
  it('makes no network or process call other than the recorded model download', () => {
    expect(run.facts.unexpectedOutboundCalls).toBe(0);
  });
});

describe('no canary appears on any output surface', () => {
  it('the encrypted store: raw bytes on disk', () => {
    expectNoLeaks(run.surfaces, name => name.startsWith('store:raw:'));
  });

  it('the encrypted store: decodable base64 lines and decrypted records', () => {
    expectNoLeaks(run.surfaces, name => name.startsWith('store:decoded:') || name.startsWith('store:decrypted:'));
  });

  it('other files under the app data folder', () => {
    expectNoLeaks(run.surfaces, name => name.startsWith('disk:'));
  });

  it('console output, stdout and stderr', () => {
    expectNoLeaks(run.surfaces, name => name === 'console');
  });

  it('the network ledger and download state', () => {
    expectNoLeaks(run.surfaces, name => name === 'ledger');
  });

  it('the full data export', () => {
    expectNoLeaks(run.surfaces, name => name === 'export');
  });

  it('exported automations', () => {
    expectNoLeaks(run.surfaces, name => name === 'export:automations');
  });

  it('the exported config, with the declines and dismissals it keeps', () => {
    expectNoLeaks(run.surfaces, name => name === 'export:config');
  });

  it('the habits summary', () => {
    expectNoLeaks(run.surfaces, name => name === 'habits');
  });

  it('the what the twin knows view, with its routines, sites and declines', () => {
    expectNoLeaks(run.surfaces, name => name === 'knows');
  });

  it('the usual time shown on each suggestion', () => {
    expectNoLeaks(run.surfaces, name => name === 'suggestions');
  });

  it('thrown error messages, with their causes and hidden properties', () => {
    expectNoLeaks(run.surfaces, name => name === 'errors');
  });

  it('outbound payloads: model downloads', () => {
    expectNoLeaks(run.surfaces, name => name === 'outbound:fetch');
  });

  it('every surface together, in every encoding the suite knows', () => {
    expectNoLeaks(run.surfaces, () => true);
  });
});

describe('the day tasks keep no raw activity', () => {
  it('builds the tasks and stores a decision, so the checks below read real data', () => {
    expect(run.surfaces.find(surface => surface.name === 'tasks')?.text).toContain('Microsoft Excel');
    expect(run.surfaces.find(surface => surface.name === 'store:decrypted:taskDecisions')?.text).toContain('confirm');
  });

  it('the task view and the decision store hold no raw canary', () => {
    expectNoLeaks(run.surfaces, name => name === 'tasks' || name === 'store:decrypted:taskDecisions');
  });
});

describe('the what the twin knows view holds real data', () => {
  it('shows the routine with its browser site, and the decline the scenario records', () => {
    const text = run.surfaces.find(surface => surface.name === 'knows')?.text ?? '';
    expect(text).toContain('docs.example.com/doc');
    expect(text).toContain('"dismissed": false');
  });
});

describe('the outbound guard is live', () => {
  it('records and refuses an unplanned fetch, socket or process call', async () => {
    const outbound: string[] = [];
    const restore = refuseOutbound(outbound);
    try {
      await expect(fetch('https://example.com/')).rejects.toThrow(/not allow/);
      expect(() => https.request('https://example.com/')).toThrow(/not allow/);
      expect(() => childProcess.spawn('true', [])).toThrow(/not allow/);
    } finally {
      restore();
    }
    expect(outbound).toEqual(['UNEXPECTED fetch GET https://example.com/', 'UNEXPECTED https.request', 'UNEXPECTED child_process.spawn']);
  });
});

describe('known gaps, asserted so they stay visible', () => {
  // Not fixed here. The plain-word rule keeps a lowercase first path segment, which can be a username. Fixing it changes
  // the template contract that redact.test.ts pins, so it needs an owner decision. This assertion flips to a failure
  // once the gap is closed, and then `it.fails` should become `it`.
  it.fails('a lowercase identifier in the first path segment becomes :id (plan 5.4)', () => {
    expect(templateUrl('https://github.com/jsmith')).toBe('github.com/:id');
  });
});

/** The working day the planted scenario uses, with no canary in it, so the same four-step routine is detected. */
function routineDays(count: number): Record<string, unknown>[] {
  return Array.from({ length: count }, (_, day) => [
    { kind: 'focus', ts: at(day, 9), app: 'Microsoft Excel' },
    { kind: 'focus', ts: at(day, 9, 20), app: 'Microsoft Outlook' },
    { kind: 'focus', ts: at(day, 9, 30), app: 'Slack' },
    { kind: 'focus', ts: at(day, 10), app: 'Google Chrome', url: 'https://docs.example.com/doc/1ab2cd3ef4567890/edit' },
    { kind: 'idle_start', ts: at(day, 10, 10) },
    { kind: 'idle_end', ts: at(day, 13) },
  ]).flat();
}

// A typed name is the person's own label. The encrypted store keeps it and the page shows it, but the data export is plain
// text, so the export carries a placeholder in its place.
describe('typed names stay out of the data export', () => {
  it('a typed task name stays out of the data export', () => {
    const root = mkdtempSync(join(tmpdir(), 'twin-privacy-rename-'));
    const agent = new TwinAgent({ dataDir: join(root, 'twin'), dataKey: randomBytes(32), now: () => at(10, 0) });
    try {
      agent.ingest({ kind: 'focus', ts: at(9, 9), app: 'Microsoft Excel' });
      agent.ingest({ kind: 'focus', ts: at(9, 9, 10), app: 'Slack' });
      const day = dayKeyOf(at(9, 12));
      agent.decideTask({ day, kind: 'rename', taskId: agent.dayTasks(day).tasks[0].id, name: CANARIES.typedText });
      expect(agent.dayTasks(day).tasks[0].name).toBe(CANARIES.typedText);
      expect(JSON.stringify(agent.exportAll())).not.toContain(CANARIES.typedText);
    } finally {
      agent.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('a typed automation name stays out of the data export', () => {
    const root = mkdtempSync(join(tmpdir(), 'twin-privacy-automation-'));
    const agent = new TwinAgent({ dataDir: join(root, 'twin'), dataKey: randomBytes(32), now: () => at(10, 0) });
    try {
      agent.updateConfig({ watchBrowsers: true });
      for (const signal of routineDays(10)) agent.ingest(signal);
      const suggestion = agent.suggestions().find(candidate => candidate.routine.steps.length === 4);
      if (!suggestion) throw new Error('The scenario should detect a four-step routine.');
      const id = agent.acceptRoutine(suggestion.routine.id).automation.id;
      agent.renameAutomation(id, CANARIES.typedText);
      // The rename is in place, so the export check below is not an empty pass.
      expect(agent.automations()[0].automation.name).toBe(CANARIES.typedText);
      expect(JSON.stringify(agent.exportAll())).not.toContain(CANARIES.typedText);
    } finally {
      agent.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('stored events hold only the allowed shape', () => {
  const allowed = ['id', 'ts', 'kind', 'app', 'windowClass', 'urlTemplate'];

  it('has no key for a title, a field value, typed text or the clipboard', () => {
    for (const event of run.events) {
      expect(Object.keys(event).filter(key => !allowed.includes(key))).toEqual([]);
    }
  });

  it('keeps no query string, fragment or userinfo in any URL template', () => {
    for (const event of run.events) {
      if (event.urlTemplate === undefined) continue;
      expect(event.urlTemplate).not.toMatch(/[?#@]/);
    }
  });
});
