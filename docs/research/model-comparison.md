# Which chat model should name routines?

Recorded 2026-11-01 on one Linux x64 machine: Ubuntu 24.04, 4 logical CPUs, 15.7 GiB of memory, no GPU, CPU only. The three
candidates are the catalogue's Qwen3 models at 0.6B, 1.7B and 4B. The raw reports are in
[`model-comparison-data/`](model-comparison-data), and `scripts/model-smoke/score-names.py` computes the scores below from
them.

## Result

The **Qwen3 1.7B** model (Q8_0) fits best of the three. It gives a clean name for 88% of the test routines, takes about
2.4 seconds a name, and uses about 4.1 GiB of memory. The planner now recommends it on devices with enough memory, and the
4B model is no longer recommended for naming.

Two other findings change how the planner works. Its memory estimate was 30 to 34% short for the larger models, so the
planner now uses the measured peak where it is known. And the 4B model, which it recommended on a 16 GiB laptop, was
the worst at naming.

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
