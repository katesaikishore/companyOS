# Which chat model should name routines?

Recorded 2026-11-01 on one Linux x64 machine: Ubuntu 24.04, 4 logical CPUs, 15.7 GiB of memory, no GPU, CPU only. The three
candidates are the catalogue's Qwen3 models at 0.6B, 1.7B and 4B. The raw reports are in
[`model-comparison-data/`](model-comparison-data), and `scripts/model-smoke/score-names.py` computes the scores below from
them.

## Result

The **Qwen3 1.7B** model (Q8_0) fits best of the three. It gives a usable name for 88% of the test routines, takes about
2.4 seconds a name, and uses about 4.1 GiB of memory. The planner now recommends it on devices with enough memory, and the
4B model is no longer recommended for naming.

Two other findings change how the planner works. Its memory estimate was 30 to 34% short for the larger models, so the
planner now uses the measured peak where it is known. And the 4B model, which it recommended on a 16 GiB laptop, was
the worst at naming.

## Qwen 3.5 and 3.6 / 3.8: what exists, and the smaller models tested

As of 2026-11-01 the Qwen family has moved on from the Qwen3 models in the catalogue:

- **Qwen 3.5** (2026-02). Small models at 0.8B, 2B, 4B and 9B are official Qwen repositories, Apache-2.0. Unsloth publishes
  GGUF builds of the 2B and 4B models, also Apache-2.0. The official cards compare the 2B model with Qwen3-1.7B and
  Qwen3-4B-2507 ([Qwen3.5-2B card](https://huggingface.co/Qwen/Qwen3.5-2B)). The 4B card compares only with much larger
  models, so it doesn't give a like-for-like comparison.
- **Qwen 3.6** (2026-04). The first release was a 27B dense model and a 35B mixture-of-experts model with about 3B active
  parameters. No small size was released.
- **Qwen 3.8** (2026-08). The official Qwen organisation lists six 3.8 repositories: 27B (27.8B dense), Flash-Next (about
  180B), 2.4T-A95B, and FP8 variants of these. The smallest is the 27B, too large for this device. The GitHub README
  mentions no small size either. An unofficial page mentioning a "Qwen3.8 4B" distilled model was not verified and is not
  used here.

The planner cannot use any Qwen 3.6 or 3.8 model on a 16 GiB laptop. The 27B dense model is about 16 GB at 4-bit, so the
smaller Qwen 3.5 models are the candidates.

### Published benchmarks, non-thinking mode

The app runs naming with thinking off, so the non-thinking rows matter most. Scores are from the official cards.

| Benchmark | Qwen3-1.7B | Qwen3.5-2B | Qwen3-4B-2507 |
|---|---|---|---|
| MMLU-Pro | 40.2 | 55.3 | 69.6 |
| IFEval | 68.2 | 61.2 | 83.4 |

The 2B model is ahead of Qwen3-1.7B on knowledge (MMLU-Pro) but behind it on instruction following (IFEval). Naming
depends on following the output format, so the naming test below matters more than these scores.

### What the app does with Qwen 3.5 today

The app's naming worker uses a chat session, which turns thinking on by default for Qwen 3.5. The app's `/no_think`
switch does not turn it off. With the grammar, the 2B model returned no name for any of the three seeded routines
(`model_error`). The app's worker discards the error text on purpose, so the cause was found by hand. Writing the chat
template out with an empty thinking block (`<think></think>`) and keeping the same JSON grammar fixed it.

The worker can now run Qwen 3.5 with thinking off. A catalogue model with `template: 'chatml_no_think'` has its prompt
written out with an empty thinking block, as the check above did. On the 2B file, the real worker gives `model_error` for
all three seeded routines with the chat session, and a name for each with the no-think template: "work routine", "work
routine", "zoom and notion" (`llm/template.ts`, and the gated check in `apps/desktop/test/real-models.test.ts`). Qwen 3.5
is not in the catalogue yet, so no user can download one. Adding it changes the default download, which is a decision for
the owner.

### Naming test, thinking off

`scripts/model-smoke/chat-naming-raw.mjs` names the same 60 synthetic routines with the template written out and the same
JSON grammar. It writes the report that `score-names.py` reads. This is not the app's own path, so the 1.7B and 4B rows
above (from the app's chat session) are not exactly the same method. The results are in
`model-comparison-data/qwen3.5-2b-raw.json` and `qwen3.5-4b-raw.json`. The script needs the two Qwen 3.5 catalogue entries
to run, which are not in the catalogue yet.

| | Qwen3-1.7B (app path) | Qwen3.5-2B (thinking off) | Qwen3-4B (app path) | Qwen3.5-4B (thinking off) |
|---|---|---|---|---|
| Passing the namer's check | 59 of 60 | 59 of 60 | 59 of 60 | 60 of 60 |
| Usable names | 53 (88%) | 55 (92%) | 56 (93%) | 56 (93%) |
| Clean names that name an app of the routine | 19 | 32 | 4 | 54 |
| Median call, one name | 2.4 s | 3.8 s | 7.2 s | 9.6 s |
| Model file | 1.8 GB (Q8_0) | 2.0 GB (Q8_0) | 2.5 GB (Q4_K_M) | 4.5 GB (Q8_0) |

Reading the table:

- **Qwen3.5-2B** is the best value in this set. Its usable share is about the same as the 4B models, and it names apps more
  often than the 1.7B model. It is slower than the 1.7B model, and its file is about the same size. Its names are readable,
  but many are generic ("work routine", "work sessions"), and one was wrong ("spreadsheet automation" for Excel, Outlook
  and Slack).
- **Qwen3.5-4B** names an app in 54 of 60 routines, but the names are mostly literal lists of apps ("pages xcode notion
  safari microsoft word"). A list like that is accurate but not how a person would name a routine. It is also the slowest
  model, and its Q8 file is 4.5 GB, which the planner would rate "tight" on a 16 GiB laptop.
- **Memory** was not measured in the raw harness, so the 2B and 4B memory figures are unknown here. The app's worker
  reported 4.4 GiB for the 2B model while it was failing, which includes its context, so it is not comparable.

**Recommendation.** The 2B model is the candidate to recommend for naming: about the same usable share as the best model here, more
app-specific names than the 1.7B model, and a 2 GB file. The recommendation stays on Qwen3 1.7B until the 2B model has a
catalogue entry, because that changes the default download. That is a decision for the owner.

## What was measured

The same 60 routines went to each model. They are the seeded synthetic routines from `scripts/model-smoke/lib.mjs`
(seed 12345), built from the app catalogue. Each model ran through the app's compiled naming worker, as the app runs it.
One name per routine, with the app's own prompt and its limits: a 64-token output, a 20-second wait, and the namer's
output check.

| | 0.6B | 1.7B | 4B |
|---|---|---|---|
| Names that pass the namer's check | 45 of 60 (75%) | 59 of 60 (98%) | 59 of 60 (98%) |
| Passing names that are one word | 31 | 12 | 0 |
| Names with an underscore, which the namer rejects (of all 60) | 15 | 1 | 0 |
| **Usable names** (clean, and it names an app of the routine or is a plain description) | **31 of 60 (52%)** | **53 of 60 (88%)** | **56 of 60 (93%)** |
| Clean names that name an app of the routine | 31 (52%) | 19 (32%) | 4 (7%) |
| Median call, one name | 1.31 s | 2.43 s | 7.19 s |
| Peak memory of the worker | 1.8 GiB | 4.1 GiB | 5.2 GiB |
| Decode speed | 13.1 tokens/s | 8.0 tokens/s | 3.9 tokens/s |
| Median call with one busy program: four threads / half the cores (six calls each) | 4.9 s / 0.9 s | 6.4 s / 2.1 s | 13.7 s / 6.7 s |

Examples from the same routines (full list in the raw data):

| Routine | 0.6B | 1.7B | 4B |
|---|---|---|---|
| visual studio code > google chrome > microsoft teams | `VISUAL_STUDIO_CODE` (rejected) | `code and browse` | `Work Session Routine` |
| microsoft excel > microsoft outlook > slack | `excel outlook slack` | `work communication` | `Workday Communication Routine` |
| zoom > notion > microsoft outlook | `zoom notion microsoft outlook` | `daily email and note management` | `Check Work Emails and Notes` |
| telegram > google chrome > pycharm > firefox | `telecom` | `work productivity tools` | `Work Session Routine` |
| libreoffice calc > microsoft teams > zoom | `REPEATS` | `office suite` | `Work meetings` |

## How the scores are made

- **Passing names** are the namer's own check: 3 to 60 characters, letters, digits and light punctuation (no
  underscore), at most eight words. The check is in `packages/core/src/llm/output.ts`.
- **Clean** means the name has no underscore, is not all capitals, and is longer than two characters.
- **Naming an app** means the name contains a word for an app in the routine, from a fixed list of words per app (for
  example `excel` for Microsoft Excel, `code` or `visual` for Visual Studio Code). The list is in the script.
- **Plain description** means the name contains a general word such as work, workflow, productivity, tools, routine,
  meeting or communication, and does not name an app. Those names are counted as usable, but they say little about the
  routine. This is generous to the larger models, and the table shows the two counts separately for that reason.

The scores are automatic. They were not checked by a person, and I read the table to see whether they match what a
person would expect. They do, with the caveat about plain descriptions above.

## Why 1.7B

The question is which name to show a person for a routine they may accept. Three things matter, in this order:

1. **A name must not be junk.** The 0.6B model gave an unusable name for 29 of 60 routines: 15 were rejected for an
   underscore, and 14 passed the check but were capitalised run-ons or invented words, such as `WORDOUTLOOKNOTION`,
   `REPEATS`, `telecom` for Telegram and `MINDING`. A junk name reads as a bug.
2. **A name should say what the routine is.** The 0.6B model names an app more often, when it does not produce junk. The
   1.7B model names an app for a third of the routines and gives a plain description for most of the rest. The 4B model
   almost never names an app: 4 of 60, and most of its names are "Work session routine".
3. **It should run in time.** All three are well inside the 20-second limit on a quiet machine. With one busy program on
   the machine, using all four threads, the 4B model's median call reaches 13.7 seconds, close to the limit. The app runs the
   model on half the cores, as the earlier real-model check set it, and then the 4B model's median is 6.7 seconds and the
   1.7B model's 2.1 seconds.

The 1.7B model meets the first point nearly always and the second point about as well as the 0.6B model does without the
junk. The 4B model is the largest and is the least specific, and it is the slowest.

## What the planner does now

- **Recommendation.** The largest chat model that fits comfortably and is recommended for naming. The 4B, 8B and 14B
  models are listed as alternatives, not recommended. The 4B model was measured worse. The 8B and 14B models were not
  measured.
- **Memory.** The estimate, weights times 1.25 plus a gigabyte, is now raised to the measured peak where a model has one.
  For the 1.7B model the estimate was 3.1 GiB against 4.1 GiB measured, and for the 4B model 3.9 GiB against 5.2 GiB. For the
  0.6B model they agree within 1%. The measured peaks are recorded in `measuredPeakBytes` in the catalogue.
- **Effect on devices.** On a 16 GiB laptop without a GPU the recommendation changes from the 4B model to the 1.7B model.
  On an 8 GiB Mac with unified memory the 1.7B model is "tight", so the 0.6B model is recommended. On a 4 GiB machine the 0.6B
  model is still the only one that fits.

## Limits

- **One machine, CPU only.** The times and memory are for this machine. A GPU, or Apple silicon with its shared memory, will
  differ, and Apple silicon was not measured.
- **Synthetic routines.** They come from the app catalogue and are not from real use. Real routines may name apps the
  catalogue does not know, which these do not test.
- **No human rating.** The scores are automatic, as described above.
- **One run per model.** The names are a single sample from each model. The output is not repeated, so variation between
  runs is not measured.
- **The naming prompt was not changed.** The 4B model's generic names may reflect the prompt as much as the model. A prompt
  that asks for an app name could lift the 4B model, but that was not tried.

## Reproduce

```bash
COMPANYOS_CHAT_MODEL=qwen3-1.7b COMPANYOS_MODEL_CACHE=/path/to/cache \
  node scripts/model-smoke/chat-naming.mjs > qwen3-1.7b.json
node scripts/model-smoke/score-names.py qwen3-1.7b.json
```

The downloads are checked against the catalogue's SHA-256 digests. The worker runs as the app runs it.
