/**
 * Opt-in checks against the real models. Skipped unless COMPANYOS_REAL_MODELS=1, because they need about 0.8 GB of
 * models (downloaded once, with the catalogue's size and SHA-256 checked) and a few minutes of CPU.
 *
 * Run: npm run build, then
 *   COMPANYOS_REAL_MODELS=1 COMPANYOS_MODEL_CACHE=/path/to/cache npm run test -w @companyos/desktop -- real-models
 *
 * The chat checks run the app's compiled worker (apps/desktop/dist/main/llm-worker.js) in a Node child process, not in
 * Electron. See scripts/model-smoke/ and docs/research/real-model-checks.md.
 */
import { existsSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const enabled = process.env.COMPANYOS_REAL_MODELS === '1';
const SCRIPTS = '../../../scripts/model-smoke';
/**
 * These checks are about whether the worker answers, not how fast. The namer's own limit is 20 s, and a shared machine
 * can pass it, so they wait longer. Speed under load is measured by scripts/model-smoke/chat-naming.mjs.
 */
const PATIENT = { timeoutMs: 120_000 };

describe.skipIf(!enabled)('real models (COMPANYOS_REAL_MODELS=1)', () => {
  it('embeds with nomic-embed-text-v1.5: 768 numbers, and similar text scores closer than unrelated text', async () => {
    const { cosine, ensureModel } = await import(`${SCRIPTS}/lib.mjs`);
    const { loadEmbedder } = await import(`${SCRIPTS}/embedder.mjs`);
    const { path, dir } = await ensureModel('nomic-embed-text-v1.5', () => undefined);

    const embedder = await loadEmbedder({ modelsDir: dir, modelPath: path });
    try {
      const a = await embedder.embed('Open the spreadsheet, then email the weekly report to the team.');
      const b = await embedder.embed('After updating the spreadsheet, send the weekly report by email.');
      const c = await embedder.embed('The cat slept on the warm windowsill all afternoon.');
      for (const vector of [a, b, c]) {
        expect(vector).toHaveLength(768);
        expect(vector.every(Number.isFinite)).toBe(true);
      }
      expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
      expect(cosine(a, b)).toBeGreaterThan(cosine(b, c));
    } finally {
      await embedder.dispose();
    }
  }, 300_000);

  it('refuses an embedding model that is outside the models folder', async () => {
    const { loadEmbedder } = await import(`${SCRIPTS}/embedder.mjs`);
    await expect(loadEmbedder({ modelsDir: '/tmp', modelPath: '/etc/hostname.gguf' })).rejects.toThrow();
  });

  describe('chat model (Qwen3 0.6B) through the real worker', () => {
    async function open() {
      const lib = await import(`${SCRIPTS}/lib.mjs`);
      expect(existsSync(`${lib.repoRoot}/apps/desktop/dist/main/llm-worker.js`), 'run npm run build first').toBe(true);
      const { path, dir } = await lib.ensureModel('qwen3-0.6b', () => undefined);
      const pids: number[] = [];
      const client = new lib.core.LocalModelClient({
        modelPath: path,
        modelsDir: dir,
        start: () => {
          const worker = lib.startRealWorker();
          pids.push(worker.child.pid);
          return worker.channel;
        },
      });
      return { lib, client, pids, path, dir };
    }

    it('names three seeded routines: the worker answers each one, and at least one name passes the namer check', async () => {
      const { lib, client } = await open();
      try {
        await client.warm();
        const { routines } = lib.seededRoutines();
        expect(routines).toHaveLength(3);
        const results = [];
        for (const routine of routines) results.push(await lib.core.nameRoutine(routine, { completer: client, ...PATIENT }));
        // A 0.6B model does not always write a name the check accepts (see docs/research/real-model-checks.md). What must
        // hold is that the worker answers: no timeout and no model error.
        expect(results.every(result => result.source === 'model' || result.reason === 'invalid_output')).toBe(true);
        expect(results.filter(result => result.source === 'model').length).toBeGreaterThanOrEqual(1);
      } finally {
        client.stop();
      }
    }, 300_000);

    it('gives a name or an invalid name, not a model error, for the widest routine the engine can produce', async () => {
      const { lib, client } = await open();
      try {
        await client.warm();
        const result = await lib.core.nameRoutine(lib.widestRoutine(), { completer: client, ...PATIENT });
        expect(result.source === 'model' || result.reason === 'invalid_output').toBe(true);
      } finally {
        client.stop();
      }
    }, 300_000);

    it('stops the worker on a timeout and starts a new one for the next request', async () => {
      const { lib, client, pids } = await open();
      try {
        await client.warm();
        const { routines } = lib.seededRoutines();
        const timedOut = await lib.core.nameRoutine(routines[0], { completer: client, timeoutMs: 30 });
        expect(timedOut).toEqual({ source: 'rule', reason: 'timeout' });
        // A stopped worker finishes the step it is computing before it exits, so wait for it instead of sleeping.
        expect(await lib.waitUntilGone(pids[0])).toBe(true);

        const next = await lib.core.nameRoutine(routines[0], { completer: client, ...PATIENT });
        expect(next.source === 'model' || next.reason === 'invalid_output').toBe(true);
        expect(pids).toHaveLength(2);
      } finally {
        client.stop();
      }
    }, 300_000);

    it('refuses a model file that is a link out of the models folder', async () => {
      const { lib, path } = await open();
      const { mkdirSync, mkdtempSync, symlinkSync } = await import('node:fs');
      const { tmpdir } = await import('node:os');
      const { join } = await import('node:path');
      const outside = mkdtempSync(join(tmpdir(), 'model-smoke-outside-'));
      const inside = join(outside, 'models');
      mkdirSync(inside);
      symlinkSync(path, join(outside, 'outside.gguf'));
      symlinkSync(join(outside, 'outside.gguf'), join(inside, 'linked.gguf'));
      const client = new lib.core.LocalModelClient({
        modelPath: join(inside, 'linked.gguf'),
        modelsDir: inside,
        start: () => lib.startRealWorker().channel,
      });
      try {
        const { routines } = lib.seededRoutines();
        expect(await lib.core.nameRoutine(routines[0], { completer: client, ...PATIENT })).toEqual({ source: 'rule', reason: 'model_error' });
      } finally {
        client.stop();
      }
    }, 300_000);
  });
});

/**
 * Qwen 3.5 turns thinking on in its chat template, so the worker writes the turn out with thinking off. The model is not
 * in the catalogue yet, so this check takes its file by path. Before the template was written out, every seeded routine
 * came back as a model error.
 */
describe.skipIf(!enabled || !process.env.COMPANYOS_QWEN35_GGUF)(
  'Qwen 3.5 with thinking off (COMPANYOS_QWEN35_GGUF=path to the .gguf)',
  () => {
    it('names the seeded routines through the real worker: no model error or timeout, and at least one name passes the check', async () => {
      const { dirname } = await import('node:path');
      const lib = await import(`${SCRIPTS}/lib.mjs`);
      const file = process.env.COMPANYOS_QWEN35_GGUF as string;
      const client = new lib.core.LocalModelClient({
        modelPath: file,
        modelsDir: dirname(file),
        template: 'chatml_no_think',
        start: () => lib.startRealWorker().channel,
      });
      try {
        const { routines } = lib.seededRoutines();
        const results = [];
        for (const routine of routines) results.push(await lib.core.nameRoutine(routine, { completer: client, ...PATIENT }));
        expect(results.some(result => result.reason === 'model_error' || result.reason === 'timeout')).toBe(false);
        expect(results.filter(result => result.source === 'model').length).toBeGreaterThanOrEqual(1);
      } finally {
        client.stop();
      }
    }, 600_000);
  },
);
