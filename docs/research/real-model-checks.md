# Real-model checks

Recorded 2026-10-31 on the `real-model-checks` branch. Scope: one Linux machine, CPU only, outside Electron. macOS,
Windows, GPUs, larger models and the packaged app were not tried.

This checks two claims from the README "Not done yet" list: naming with a real chat model had never been run (the tests
use a fake worker), and the embedding model was downloaded but never loaded.

**Short answer.** Both models load and run. Naming works end to end, but Qwen3 0.6B writes poor names: a quarter of its
answers are rejected by the namer's check, and most of the rest are one word. Embeddings load and behave sensibly. Two
real problems were found and fixed: an over-long prompt looked like a model failure, and the model stalled when
another program was using one core.

## Machine

| | |
|---|---|
| CPU | Intel Xeon (Sapphire Rapids class), 2.1 GHz, 4 vCPUs, AVX2 and AVX-512 (also VNNI and AMX) |
| Memory | 15.7 GiB, no swap |
| GPU | none |
| OS | Linux 6.18.44, x86_64, KVM guest |
| Node | 22.23.4 |
| Runtime | node-llama-cpp 3.22.1, backend `cpu` |

node-llama-cpp ships Vulkan and CUDA binaries too. With no GPU here it fell back to the CPU build without an error.

The machine was shared. Other jobs ran at the same time (load average 0.6 to 5.8 on 4 cores). Each run records the load
average. Where load changed a number, the text says so.

## What ran

1. **Download.** `scripts/model-smoke/fetch-models.mjs` called the app's `downloadModel` (https only, host allowlist,
   size and SHA-256 checked before the file is kept) for the catalogue entries `qwen3-0.6b` and
   `nomic-embed-text-v1.5`. Both matched the pinned digests, and `sha256sum` agreed. Hosts: `huggingface.co`, then
   `us.gcp.cdn.hf.co`. Qwen took 6.2 s and nomic 1.6 s. This is the code `ModelManager` calls. `ModelManager` itself
   was not run, because it imports Electron.
2. **Chat model, through the real worker.** `scripts/model-smoke/chat-naming.mjs` starts the app's compiled
   `llm-worker.js` in a Node child process (`worker-shim.cjs` supplies `process.parentPort`) and drives it with the
   engine's `LocalModelClient`, `nameRoutine` and `RoutineNamingJob`. Three routines were mined by the real engine from
   seeded days. The script has six parts (A to F below) and was run three times on the final code.
3. **Embedding model.** `scripts/model-smoke/embed.mjs` loads the model through node-llama-cpp and embeds three
   strings. Run three times.
4. **Opt-in vitest.** `apps/desktop/test/real-models.test.ts`, guarded by `COMPANYOS_REAL_MODELS=1`: 6 tests, all passed
   (about 25 s with the models cached).

## Chat model: Qwen3 0.6B Q8_0

File `Qwen3-0.6B-Q8_0.gguf`, 639,446,688 bytes, SHA-256 `9465e63a22add5354d9bb4b99e90117043c7124007664907259bd16d043bb031`.

### A and B. The three seeded routines

The output was identical in all runs (temperature 0).

| Steps | Model output | Namer's check |
|---|---|---|
| microsoft excel, microsoft outlook, slack | `excel outlook slack` | passes |
| visual studio code, google chrome, microsoft teams | `VISUAL_STUDIO_CODE` | rejected ("Use plain words and digits."), rule name kept |
| zoom, notion, microsoft outlook | `zoom notion microsoft outlook` | passes |

The check passes two of three. Neither passing name is a good name. Both only list app names, in lower case, and the
prompt asks for three to six plain words in sentence case.

A `RoutineNamingJob` pass over the same three routines (verify the file, start the worker, load, name three) took
6.5 to 7.5 s and renamed two of three.

### C. Speed

Final code, which runs the model on half the cores (2 of 4, see part F).

| Measure | Value |
|---|---|
| Worker start and model load (spawn, import, load, 2048 context) | 2.6 to 2.9 s |
| In-process split: model load / context creation | 1.10 to 1.24 s / 0.42 to 0.46 s |
| Prompt size | 132 to 136 tokens in, 7 to 9 tokens out |
| Prompt processing | 265 to 285 tokens/s (median of 9 calls per run) |
| Generation | 15.6 to 18.1 tokens/s (median of 9 calls per run) |
| First token | 0.43 to 0.57 s |
| One name, whole call, in process | median 0.89 to 0.95 s |
| One name, through the worker | 1.0 to 1.4 s |
| Limit in the namer | 20 s |

Before the thread change the model used all 4 cores. On the same machine that gave 359 to 371 tokens/s for prompt
processing, 17.5 to 20.9 tokens/s for generation, and 0.8 to 1.0 s per name when the machine was quiet. Using half
the cores costs about 25 percent in prompt processing and about 10 percent in generation, when quiet. In one of those
earlier runs another job was running and the same calls took 6.9 to 8.8 s. That is the stall in part F.

Without a grammar, generation was not clearly faster in a one-off probe (22 to 26 tokens/s against 19 to 27), so the
JSON grammar is not what limits speed here.

### Memory

Resident memory of the worker process (Linux `VmRSS`). Anonymous memory is private. File-backed memory is the
memory-mapped model file, which the OS can drop under pressure.

| Point | RSS | Anonymous | File-backed |
|---|---|---|---|
| Before loading (in-process run) | 126 to 131 MiB | 68 to 73 | 58 |
| After model load | 1,556 to 1,565 MiB | 896 to 904 | 660 |
| After context creation (2048) | 1,786 to 1,787 MiB | 1,126 | 660 |
| Worker after load | 1,761 to 1,764 MiB | 1,104 to 1,107 | 657 |
| Worker after three names | 1,805 to 1,806 MiB | 1,147 to 1,148 | 658 |
| Worker after the 60-routine sample | 1,872 to 1,942 MiB | 1,215 to 1,285 | 658 |
| Peak seen | 1,964 MiB | | |

Loading the model added about 830 MiB of anonymous memory on top of the 600 MiB mapped file. The system info line
shows `REPACK = 1`, so llama.cpp probably keeps a rearranged copy of the weights. I did not check that.

In a one-off probe of 240 consecutive names, RSS went from 1,812 MiB at call 20 to 1,830 MiB at call 240. I saw no
leak.

The app's estimate for this model, `requiredMemoryBytes`, is 1,786 MiB. The measured peak is 1 to 10 percent above it
(1,806 MiB after three names, 1,964 MiB after the 60-routine sample). It is close but has no margin for this model.
Larger models were not measured, so I cannot say how the formula holds up for them.

### E. A wider sample

60 made-up routines (3 to 6 steps, 22 app names, fixed seed, so it can be repeated). The counts were the same in all
runs, and the names of two runs compared were identical.

| Outcome | Count |
|---|---|
| Name passes the namer's check | 45 |
| `invalid_output` | 15 |
| `timeout` or `model_error` | 0 |

Call time through the worker: median 1.13 to 1.16 s, 90th percentile 1.39 to 1.41 s, slowest 1.59 to 1.72 s.

All 15 rejections contain an underscore, such as `VISUAL_STUDIO_CODE_ZOOM_EXCEL_NOTION`. The JSON grammar cannot
forbid it, because node-llama-cpp's schema support has no character pattern. The namer keeps the rule-based name in
that case, which is the designed behaviour.

Passing is a weak bar. Of the 45 passing names, 31 are one word and only 10 have three to six words. None is in
sentence case. Examples that pass: `REPEATS` (three times), `DISCOON`, `MINDING`, `WORDFIRE`, `telecoms`,
`docx calc figma whatsapp`. A rough check (does the name contain a word from one of the routine's app names?) is true
for 35 of the 45. The namer's check accepts one to eight words in any case, while the prompt asks for three to six in
sentence case.

For comparison, the rule-based names are generic but accurate, such as `Routine: spreadsheet → mail → chat`. Reading
the output, I judge the 0.6B names no better, and names like `REPEATS` worse. This is a judgement, not a measurement.

This matters because `planSetup` recommends this model on small machines. Computed for a Linux machine with no GPU:
0.6B on 8 GiB of memory, 4B on 16 GiB, 14B on 32 GiB or more. On a 16 GiB machine with unified memory it recommends 8B.

### Prompt probe

On the three seeded routines only, once: a chat wrapper that discourages thinking gave `code-changes` for the second
routine and otherwise similar names. One worked example in the system prompt gave more natural names, but the first
one copied the example ("Draft and send a document"). Neither is clearly better, and nothing was kept. Tuning the prompt
for a 0.6B model is probably wasted effort before a larger model has been tried.

### D. Failure paths with the real worker

These had only been tested with a fake worker. All behaved as designed.

| Case | Result |
|---|---|
| Time limit of 30 ms | `timeout`, the worker process exits, the next request starts a new worker and names in 3.6 to 3.8 s |
| No request for the idle limit (1.5 s in the test) | worker exits |
| Model file is a symbolic link out of the models folder | refused, `model_error`, nothing loaded |
| `maxTokens` of 3 | request rejected, no half answer |
| Prompt of 4,001 characters | request rejected, the worker keeps serving |
| Widest routine the engine can produce | see the first fix below |

A stopped worker does not exit at once. It finishes the step it is computing first, which took between 50 ms and
300 ms or more. The first version of the vitest slept 300 ms and failed. It now waits for the process to go.

### F. Stalls when another program is busy

Found by accident: the opt-in tests failed while another job on the machine was compressing a file. The script now
measures it. It starts one busy Node process (stopped by its pid afterwards), then times the three seeded routines in
process, with all 4 threads and with 2, alternating, two passes each.

| Setting | One name, machine otherwise quiet | One name, one busy program |
|---|---|---|
| All cores (4 threads) | 0.50 to 0.85 s | 3.3 to 20.4 s (medians 4.7, 7.4, 7.5 s in three runs) |
| `modelThreads()` (2 threads) | 0.81 to 1.10 s | 0.79 to 1.17 s (medians 0.85, 0.94, 1.05 s) |
| Real worker with the fix, busy program running | | 0.96 to 1.74 s |

Other jobs were also running, so the "busy" column had more than one competing program at times. A one-off probe with
all 4 threads and two heavy jobs running gave 31 s and 40 s for single names, well past the 20 s limit.

The cause is how llama.cpp schedules: its threads wait for each other at every step, so if one core is taken, the
whole step waits. A timeout also stops the worker, and the next try reloads the model (about 3 s of full CPU), so on a
busy machine the naming job would keep taking CPU from what the person is doing.

## Fixes

### Over-long prompt looked like a model failure

The worker refuses a system text or prompt over 4,000 characters, and that refusal looks like a model failure.
`namingPrompt` did not limit app names, which can be up to 200 characters, and a routine shows up to five apps in each
of six steps. A routine with 130-character app names produced a 4,169-character prompt. The real worker refused it, and
`nameRoutine` returned `model_error`. In the naming job, `model_error` ends the pass and is retried the next minute, so
that routine would come first every time and the routines after it would never be named.

This is unlikely with real apps, whose names are short, but any local program can choose its own name.

The fix: app names are cut to 40 characters (with an ellipsis) in the prompt, which keeps the widest routine at about
1,450 characters. The 4,000 limit is now one shared constant, `MAX_WORKER_TEXT_CHARS`, used by the worker and by the
test. Three unit tests cover it (two fail without the cap), and the opt-in vitest runs the widest routine through the
real worker. Before the fix it returned `model_error`. After it, the model names it (`Work App Routine`).

A related risk was not changed. Any deterministic `model_error` for one routine still blocks the routines behind it.
I did not see another cause with the real model.

### Model used every core

`modelThreads()` (new, `packages/core/src/llm/threads.ts`) gives half of the machine's math cores, at least one. The
worker passes it to `createContext`. Nine unit tests cover the rule. The effect is the table in part F.

The trade-off is not measured for larger models. On a CPU alone, a 4B or larger model may need more threads to answer
inside the 20 s limit. With a GPU the thread count matters much less. Revisit this when larger models are measured.

## Embedding model: nomic-embed-text-v1.5 Q8_0

File `nomic-embed-text-v1.5.Q8_0.gguf`, 146,146,432 bytes, SHA-256
`3e24342164b3d94991ba9692fdc0dd08e3fd7362e0aacc396a9a5c54a544c3b7`. Loaded with `createEmbeddingContext` (context 512),
with the task prefix `clustering: ` that nomic documents. The cosine values were identical in all three runs.

| Check | Result |
|---|---|
| Vector length | 768 for all three strings |
| Values | all finite |
| Vector length (L2 norm) | 21.2 to 21.4, so vectors are not unit length. Use cosine similarity. |
| Similar pair ("Open the spreadsheet, then email the weekly report to the team." / "After updating the spreadsheet, send the weekly report by email.") | cosine 0.934 |
| Each against an unrelated string ("The cat slept on the warm windowsill all afternoon.") | 0.552 and 0.556 |
| Load, whole | 1.17 to 1.23 s (model 0.22 to 0.25 s, context 0.05 s, the rest is import and runtime start) |
| Embed one short string | 8 to 17 ms (outliers: 94 ms on a first call, 35 ms once) |
| Memory | 408 to 437 MiB RSS (anonymous 213 to 242, file-backed 195) |

The embedding run uses node-llama-cpp's default thread count. It takes milliseconds, so the stall above did not show,
but it was not tested under load.

The loader is `scripts/model-smoke/embedder.mjs`. It uses prebuilt binaries only, loads only a `.gguf` inside the
models folder (the engine's `resolveModelPath`), and makes no network call. Nothing in the app imports it, and no
product decision uses an embedding.

## Verified and not verified

Verified, on this machine only:

- Both catalogue models download and match their pinned size and SHA-256.
- The compiled worker loads Qwen3 0.6B and answers grammar-constrained requests through `LocalModelClient`,
  `nameRoutine` and `RoutineNamingJob`.
- Timeout, restart, idle stop, path refusal, cut-short generation and size limit behave as designed.
- The embedding model loads, gives 768 numbers, and ranks similar text above unrelated text on one example.
- Half the cores avoids the stall with one busy program, for this model on 4 cores.

Not verified:

- **Electron.** The worker ran in a Node child process. The Electron utility process, its `parentPort`, packaging
  (`asarUnpack` for the node-llama-cpp binaries) and the packaged app were not tried.
- **Other platforms.** macOS (Metal) and Windows were not run. Linux with a GPU was not run, so no GPU backend was
  exercised.
- **Larger chat models.** Qwen3 1.7B, 4B, 8B and 14B were not downloaded. Name quality, speed, memory, the thread
  choice and the 20 s limit are unknown for them. The planner recommends 4B or larger on machines with 16 GiB or more.
- **Name quality in general.** Judged by reading about 60 outputs, not by a person scoring them, and only for one
  prompt and one model.
- **Embeddings in use.** One example pair. Nothing about retrieval quality on real routines or past runs.
- **Battery and idle gating on a real laptop**, and the thread choice on machines with more than 4 cores.
- **The download through `ModelManager`** (progress, ledger entry, cancel), and downloads behind a proxy, which
  Electron's `fetch` may not follow.
- **The end-to-end suite** was not run for these changes. `npm run typecheck` and `npm test` were.

## Reproduce

See `scripts/model-smoke/README.md`. In short:

```
npm run build
COMPANYOS_MODEL_CACHE=/home/user/model-cache node scripts/model-smoke/chat-naming.mjs > chat.json
COMPANYOS_MODEL_CACHE=/home/user/model-cache node scripts/model-smoke/embed.mjs > embed.json
COMPANYOS_REAL_MODELS=1 COMPANYOS_MODEL_CACHE=/home/user/model-cache npm run test -w @companyos/desktop -- real-models
```
