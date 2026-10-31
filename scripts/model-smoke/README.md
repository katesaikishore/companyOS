# Real-model checks

Opt-in scripts that run the two catalogue models for real. They are not part of the app and not part of `npm test`.
Results and numbers are in `docs/research/real-model-checks.md`.

## Before you run

- Build the engine and the desktop app: `npm run build`.
- The models go outside the repository. Set `COMPANYOS_MODEL_CACHE` to a folder. The default is
  `~/.cache/companyos-model-smoke`.
- Disk: about 0.8 GB (Qwen3 0.6B is 0.64 GB, nomic-embed-text-v1.5 is 0.15 GB).

## Scripts

| Script | What it does |
|---|---|
| `fetch-models.mjs [id ...]` | Downloads catalogue models with the app's downloader (`downloadModel`) and checks size and SHA-256. A file that already verifies is kept. |
| `chat-naming.mjs` | Names three seeded routines with Qwen3 0.6B through the app's compiled worker and `LocalModelClient`. Also runs a naming job pass, failure paths, a 60-routine sample, and a test with one busy program on the machine (all cores against `modelThreads()`). Prints one JSON report. About 3 to 4 minutes. |
| `embed.mjs` | Loads nomic-embed-text-v1.5 Q8_0, embeds three strings, checks the vector length and that similar text scores closer than unrelated text. Exits 1 if a check fails. |
| `embedder.mjs` | The loader that `embed.mjs` and the vitest use. Nothing in the app imports it. |
| `worker-shim.cjs` | Runs `apps/desktop/dist/main/llm-worker.js` under plain Node by giving it a `process.parentPort`. |
| `lib.mjs` | Shared helpers: cache folder, verified download, memory from `/proc`, seeded and synthetic routines, worker start. |

```
COMPANYOS_MODEL_CACHE=/path/to/cache node scripts/model-smoke/fetch-models.mjs
COMPANYOS_MODEL_CACHE=/path/to/cache node scripts/model-smoke/chat-naming.mjs > chat.json
COMPANYOS_MODEL_CACHE=/path/to/cache node scripts/model-smoke/embed.mjs > embed.json
```

## The opt-in vitest

`apps/desktop/test/real-models.test.ts` runs the same checks as assertions. It is skipped unless `COMPANYOS_REAL_MODELS=1`.
It downloads the two models into the cache if they are missing.

```
npm run build
COMPANYOS_REAL_MODELS=1 COMPANYOS_MODEL_CACHE=/path/to/cache npm run test -w @companyos/desktop -- real-models
```

## Limits

- Linux only for memory numbers, because they are read from `/proc`.
- The worker runs in a Node child process, not in an Electron utility process.
- Timings depend on what else the machine is doing. Look at the load average in the report.
