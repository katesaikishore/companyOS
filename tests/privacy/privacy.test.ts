import { templateUrl } from '@companyos/twin-core';
import childProcess from 'node:child_process';
import https from 'node:https';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { findLeaks, describeLeak, type Surface } from './canaries';
import { PLANTED, runPlantedScenario, type ScenarioRun } from './scenario';
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

  it('the habits summary', () => {
    expectNoLeaks(run.surfaces, name => name === 'habits');
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
