# Laya as a local decision layer

Status: the optional onboarding download is built and tested (see "Onboarding download: built"). The app can fetch, check,
store and load the model bundle. As of 2026-11-01 the app uses Laya for one thing: a kind label for a routine that includes
an app the catalogue does not know. The label is shown beside the suggestion only when the model is confident (0.7), and
the rules label every other routine. No policy or approval reads it. Its accuracy was checked against the catalogue (see
"Kind labels"). Checks on companyOS decisions beyond that have not been made.

## What Laya is (checked 2026-10-31)

- **Model.** A non-autoregressive "System 1" decision model by Convai Innovations. It answers typed questions about a
  state in one forward pass: `choice`, `score`, and `noul` (yes/no). It does not write text or plans.
- **Reference weights.** [`convaiinnovations/laya`](https://huggingface.co/api/models/convaiinnovations/laya) on Hugging
  Face. License `apache-2.0`, not gated. Files include `model.safetensors` (842.6 MB) and a multilingual checkpoint
  (643.8 MB).
- **Runtime port.** [`@receptron/laya` 0.2.0](https://registry.npmjs.org/@receptron%2flaya) on npm. License MIT. It
  depends on `onnxruntime-node` ^1.22.0 and `@huggingface/tokenizers` ^0.2.0. Its README asks for Node 20 or newer.
- **ONNX bundle the port downloads.** [`receptron/laya-onnx`](https://huggingface.co/api/models/receptron/laya-onnx) on
  Hugging Face. License `apache-2.0`, not gated. `laya.onnx.data` is 1,685 MB (fp32). The tokenizer is 3.6 MB and the
  config is small. The total is about 1.69 GB.
- **Downloader.** `ensureBundle()` in the package's `dist/download.js`. Default cache: `~/.cache/receptron-laya`, or the
  `LAYA_CACHE` variable. Default revision: `main`. Each file is written to a `.part` file and then renamed. On each
  load it sends a HEAD request and re-downloads only if the size differs. It reports per-file progress.
- **Limits of that downloader.** It checks size only, not SHA-256. It does not resume a partial file, so an interrupted
  download restarts the whole 1.7 GB. It reads `main`, not a pinned commit.
- **Performance, per its README.** About 140 ms per decision on an Apple-silicon CPU once warm. Memory is the loaded
  model plus a few hundred MB per batch.

Not verified: that the search index's "receptron" and "JEV" names match the npm package's keywords, and that the ONNX
export matches the reference checkpoint. The README reports a logit difference of about 1e-5 against PyTorch. That
figure is the author's, not ours.

## Where it fits

Laya can label segments, pick a repaired locator from on-device candidates, score candidate steps, and flag untrusted
text. It cannot plan, write text, or act. The runner still plans, and the approval gates stay deterministic (D9).

## Onboarding download: recommended, with conditions

Downloading during onboarding is the better default. The 1.7 GB wait is explained up front and runs once. It doesn't
stall the first routine. Users who skip it stay on the rule-based path, which already works.

Conditions before it ships:

1. **Pin the revision** to a commit SHA, not `main`.
2. **Verify SHA-256** of the ONNX data and tokenizer files against digests stored in the app. The product's stated rule
   is that each model is checked against its digest, and the stock downloader doesn't do that. We need our own fetch
   with a hash check, or a wrapper around `ensureBundle`.
3. **Resume** with HTTP Range requests, so an interrupted 1.7 GB download doesn't restart.
4. **Ledger.** Record the download in the network ledger: host, file names and byte counts. `huggingface.co` is already
   listed for model downloads, but the privacy page should name this bundle.
5. **Delete everything** must remove the Laya cache as well as the installed models. Use the app's own models directory
   for `LAYA_CACHE` so one delete path covers both. The cache holds public weights, not user data, but the delete
   promise should still be exact.
6. **Electron packaging.** `onnxruntime-node` is a native module. It must be rebuilt for Electron's Node ABI and unpacked
   from the asar archive on macOS, Windows and Linux. This is real packaging work, and the signing and notarisation
   steps already in the release flow will cover the new binary.
7. **Disk.** Check for about 2 GB free before starting, and show a clear error if there isn't enough.
8. **No token.** The repos are not gated, so no Hugging Face token is needed.

Alternative: download on first use of a Laya-backed step. This avoids the 1.7 GB at install, but the first use stalls
with no explanation. The best option combines both: offer the download during onboarding, and fall back to a
first-use download if the user skipped it.

## Integration options

- **A. Direct.** Call `@receptron/laya` from the desktop main process, straight from the runner. Simplest, but it puts a
  native dependency into the decision path.
- **B. Behind an interface (recommended).** Define a `DecisionModel` interface in `packages/core` with the rule-based
  implementation as today. The desktop app supplies a Laya implementation. Core stays free of native code, and the
  existing fake-worker tests keep working.

## Approvals needed before implementation

The first three were given on 2026-10-31 (see "Verified pins and smoke test"). The fourth was built as the onboarding offer.

1. Adding `@receptron/laya` 0.2.0 (MIT) and its `onnxruntime-node` dependency. Done.
2. Downloading the 1.69 GB bundle, which is needed to test and to compute the SHA-256 pins. Done.
3. Computing and pinning the SHA-256 digests. This requires that one-time download. Done.
4. Choosing the onboarding offer (recommended) or first-use only. The onboarding offer is built. The first-use fallback is
   not: a person who skips the step has no download until they ask for it in Settings.

## Kind labels (built 2026-11-01)

What the app does: a routine whose steps include an app the catalogue does not know is sent to Laya with the app names
only. Laya chooses one kind of work from Web, Code, Spreadsheets, Documents, Email, Messages, Terminal, Design, Mixed and
Other. The label is shown as "Kind" on the suggestion card, with "· model" when Laya gave it. When Laya answers Other, is
below the threshold, does not answer in time, or is not installed, the rule-based label is shown. Routines made only of
catalogued apps never reach the model. The label is for display only. It is not read by policy, approvals, the runner or
the autonomy gate. A guard test in `packages/core/test/decision.test.ts` checks which modules read the model and the labels.

**Accuracy check.** `scripts/laya-check/label-eval.mjs` runs the same adapter the app uses on each catalogued app name, one
at a time, with the same question. Laya sees the name only. The catalogue's class for the name is the truth, kept from Laya.
The check ran on 57 names, on the 2026-11-01 build, with `receptron/laya-onnx` at the pinned commit. The raw output is in
`docs/research/model-comparison-data/laya-kind-labels-check.json`.

| Threshold | Names shown | Share of the 57 names | Shown labels that match the catalogue |
|---|---|---|---|
| 0.4 | 33 | 58% | 82% |
| 0.5 | 29 | 51% | 86% |
| 0.6 | 26 | 46% | 88% |
| **0.7 (chosen)** | **20** | **35%** | **95%** |

One shown label was wrong at 0.7: `powershell` was labelled Code at 0.89, and its catalogue kind is Terminal. Answers at
every threshold are in the JSON.

**Uncatalogued apps.** The check does not know their truth, so these are only what the model said. None of the 11
uncatalogued names reached 0.7. The highest was 0.53, for Arc and Raycast, and several were wrong: Arc was given Code,
Zed Messages, and Warp and Ghostty Code and Messages. So for an app the catalogue does not know, the rules will usually
keep their label, and the model adds little. Adding the app to the catalogue is cheaper and more accurate than trusting a
label of 0.7 or less. The model is most useful for the rare name it knows well.

**Cost.** The model loaded in 7 to 117 seconds: 117 seconds on a cold disk cache, and 7 to 8 seconds once the file was
cached. One answer took a median of 0.40 seconds and 0.49 seconds at the 90th percentile. The model is freed after five
idle minutes. Its memory while loaded was not measured in the app.

**Timeouts.** The eight-second limit now covers loading as well as the answer. A first load that is still running at the
limit is abandoned for that call, and it finishes in the background, so the next call finds the model ready.

**Not built.** The decision model is not used for locator repair, for scoring candidate steps, or for flagging untrusted
text, which the design also allows. Those would need their own checks. The embedding model is still downloaded and never
loaded.

## Not done

- The threshold was set on 57 catalogue names with one model on one machine. Real routines may behave differently, so the
  check should be run again before the threshold is changed.
- No measurement of the real footprint on the three platforms, and no packaging run on macOS or Windows. The Linux
  unpacked app was built and run (see "Onboarding download: built").
- The kind labels were not run inside a running app with the real bundle installed. Their adapter, the job and the release
  timer are tested with fakes, and the adapter was run against the real bundle outside the app.

## Verified pins and smoke test

Added 2026-10-31 after the owner approved the dependency and the download. The dependency is in
`apps/desktop/package.json`. The bundle is in `/home/user/laya-cache` on the machine where this was run, outside the repo.

### Pins

- **Package.** `@receptron/laya` 0.2.0, exact version, in `apps/desktop/package.json`. The lockfile resolves
  `onnxruntime-node` 1.31.1 (range `^1.22.0`) and `@huggingface/tokenizers` 0.2.0.
- **Model revision.** `receptron/laya-onnx` at commit `d42786bdff8a7550316339c5fbf8f46caa83ea1b`, the `sha` field of
  the Hugging Face API response (checked 2026-10-31). The pin is this commit, not `main`.

| File | Bytes | SHA-256 | Check against Hugging Face |
|---|---|---|---|
| `laya.onnx` | 3807291 | `a874eb254b58b0fcb1e7ad56fbb188c29d64e08c9a46b689433e1f52c66dba1e` | Match: `lfs.sha256` and size |
| `laya.onnx.data` | 1685258240 | `487746363a8da57bcadb4345352997d22a0fb90d70aa22c6856668d023242aba` | Match: `lfs.sha256` and size |
| `laya_config.json` | 355 | `c4fab3dd16b6ffdb432ae99334c77fca31e1b4beb0b81be76ca45f707709706a` | Match: size and git blob id. No SHA-256 is published for this file. |
| `tokenizer/tokenizer.json` | 3583228 | `6c8aaa9a542084f2457eab775d4eeb51f92a70c0fd9de28d5edb0ddec3c08d30` | Match: size and git blob id. No SHA-256 is published for this file. |
| `tokenizer/tokenizer_config.json` | 308 | `50044de60daaa73df97d262e15a40d4faf0160e7d742df64b377877a1320dd12` | Match: size and git blob id. No SHA-256 is published for this file. |

For the three small files, Hugging Face publishes only a git blob id (a SHA-1 over the content). The match confirms the
content, but it is not a SHA-256 check. The two large files were checked against their published SHA-256 digests.

### Download

Fetched with the package's `ensureBundle`, using `repo`, `revision` (the pinned commit), `cacheDir` and `onProgress`.
The download took 14.3 s on this machine. No partial files were left behind.

### Smoke test

Environment: Linux x64, Node 22.23.4, CPU execution provider. This is not the Apple-silicon machine the README timings
come from. The input is the README's example ticket with a three-option `choice` question (billing, support, sales),
loaded through `Laya.load({ repo, revision, cacheDir })`.

- **Load, app-style path** (`repo`, `revision`, `cacheDir`): 9.7 s. This includes the HEAD checks and the re-download
  described below.
- **Load from the local directory** (`modelDir`): 7.8 s.
- **Decision.** First call 245.9 ms, then 162.4, 148.6 and 157.8 ms. Input was 61 tokens.
- **Answer.** `billing`, with probabilities billing 0.4768, support 0.375 and sales 0.1482. `answer_confidence` is 0.4768.

The call works and returns a sensible answer, but the numbers do not match the README. The README shows billing 0.9415,
support 0.031 and sales 0.0275 for its example. The README's example text is abbreviated ("..."). That may explain the
gap, but this is not verified. The README's full three-question example did not reproduce either: urgency score 1.1576
(README 1.3886) and churn `noul` 0.0089 (README 0.0988). The department probabilities were the same in the three-question
call as in the single-question call, so batching does not change the department answer.

### Downloader issue

The stock `ensureBundle` re-downloads `tokenizer/tokenizer.json` on every load. Its HEAD check reads `content-length`
after redirects. Checked with curl: when gzip is negotiated, as Node's fetch does, the final response has no
`content-length`. The code then reads 0, which differs from the local size, so the file is fetched again. The
re-downloaded file still matches its digest. The size-only check is not an integrity or freshness check, so the
SHA-256 verification in the conditions above is still needed.

### Lockfile

`npm install` added 9 packages: `@receptron/laya`, `onnxruntime-node` and its tree (`onnxruntime-common`, `adm-zip`,
and four packages nested under `onnxruntime-node`), and `@huggingface/tokenizers`. No existing package version or
integrity hash changed. Twenty-six existing entries changed their `dev`, `optional` or `peer` flags. This happens because
`onnxruntime-node` brings `global-agent` and its dependencies (for example `globalthis` and `define-properties`) into
the production tree. Those packages are now production dependencies. Whether the packaged app includes them is not
verified, because no packaging run was done.

### Not verified

- Laya's accuracy on companyOS decisions.
- The README's documented decision numbers (above), and whether the ONNX export matches the reference checkpoint. The
  README's 1e-5 logit claim is the author's, not ours.
- Behaviour on macOS and Windows, and inside Electron. `onnxruntime-node` is a native module and has not been rebuilt for
  Electron's Node ABI or unpacked from asar.
- Memory use and the cost of a full load on the target machines. Only the load times above were measured.
- Resuming an interrupted download. It was not tested.

## Onboarding download: built

Added 2026-10-31. Each condition from "Onboarding download: recommended, with conditions" is met as follows. The code is
in `apps/desktop/src/main/laya.ts`, and the types are in `packages/core/src/decision.ts` and `packages/core/src/models/types.ts`.

| Condition | How it is met |
|---|---|
| 1. Pin the revision | Every URL has the commit `d42786bdff8a7550316339c5fbf8f46caa83ea1b`. A spec whose revision is not a 40-character hash is refused. |
| 2. Verify SHA-256 | Each file is hashed on disk after the download, and renamed into place only if its size and digest match the pin. A mismatch deletes the partial file. The pins are in the table above, and a test compares them with the code. |
| 3. Resume | A partial file is kept and continued with an HTTP Range request. A server that ignores Range, or answers 416 or the wrong range, makes the file start again. |
| 4. Ledger | One entry per file per attempt: `model_download`, model `laya-onnx`, the file name, the host that served the bytes, the path with the commit, and the bytes fetched in that attempt. |
| 5. Delete everything | The bundle is under `<app data>/models/laya/`. Delete everything stops a running Laya download first, then removes the whole models folder. |
| 6. Electron packaging | See "Packaging" below. |
| 7. Disk | The download needs 2 GB free (decimal), counting bytes of this bundle already on disk. If free space cannot be measured, the download goes ahead. |
| 8. No token | No credential header is sent. A test checks every request. |

### What was added

- **`DecisionModel`** (core). A typed question (`choice`, `score` or `noul`, which is yes/no) with a state, answered or
  abstained. The default implementation always abstains. Nothing in the runner or the agent imports it, and a test checks
  that no engine file does. The approval gates stay deterministic.
- **Bundle manager** (desktop main process). Download, resume, cancel, verify, remove, and a lazy `load()`. `load()`
  hashes all five files, then imports `@receptron/laya` and calls `Laya.load({ modelDir })`, which reads local files and
  sends no request. The package is not imported before that. Nothing in the app calls `load()`.
- **Setup step.** A new optional step 4, "Decision model", between the device step and "Start observing". It states
  the size (about 1.7 GB), says that the model is optional and what it is used for, and has Download, Cancel, Resume, Delete partial download
  and "Skip, use rules". Cancel keeps what was downloaded. Settings lists the model and can remove it.
- **Ledger page.** A multi-file download shows the file name in its row and in the exact-request panel.

### Packaging

- `onnxruntime-node` 1.31.1 ships Node-API (`napi-v6`) bindings for darwin/arm64, linux/x64, linux/arm64, win32/x64 and
  win32/arm64, checked by listing the installed package. So `npmRebuild` stays `false`. It ships none for darwin/x64. The
  app does not offer the bundle on Intel Macs.
- `electron-builder.yml` unpacks `onnxruntime-node/bin/**` from the asar archive, and each platform build keeps only its
  own platform and architecture. The two GPU providers that `npm install` fetches for linux/x64 (about 285 MB) are left
  out, because the model runs on the CPU.
- `npm run dist:dir` works on Linux. In the unpacked app, `app.asar.unpacked/node_modules/onnxruntime-node/bin/napi-v6/linux/x64`
  holds `onnxruntime_binding.node`, `libonnxruntime.so.1` and `libonnxruntime_providers_shared.so`. electron-builder
  already unpacks a package that contains a `.node` file, so the explicit entry documents the intent more than it changes
  the result.
- Cross-building on Linux with `--mac --arm64 --dir` and `--win --dir` gave only `darwin/arm64` (3 files) and only
  `win32/x64` (4 files, including DirectML). Those two builds were listed, not run.
- Size added per platform, from the listing: about 90 MB on macOS arm64 (the dylib is shipped twice), 48 MB on Linux x64,
  and 68 MB on Windows x64.
- `npm ci` runs the package's install script, which downloads the GPU providers on linux/x64. Setting
  `ONNXRUNTIME_NODE_INSTALL=skip` for `npm ci` skips that download. It is not set in the workflows yet.

### Verified

- **Unit tests with a local server standing in for Hugging Face.** Range requests, a truncated download then a resume, a
  server that ignores Range, a 416, a wrong Content-Range, a corrupted file, a wrong declared size, a stream longer than
  the pin, a redirect to an allowed and to a refused host, cancel, the disk check, the ledger entries, no credential, remove,
  and Delete everything with a running download. The server and the tests use small files with their own digests. They never
  fetch the real bundle.
- **The real servers, small files only.** The four small pinned files (7.4 MB) were fetched from Hugging Face through the
  manager, with a connection loss simulated after 1.5 MB. The resume sent `Range: bytes=1452267-` and got a 206 from the
  `us.gcp.cdn.hf.co` host. All four digests matched the pins. For the 1.7 GB file, a 100-byte Range request returned 206 with
  `Content-Range: bytes 1685258140-1685258239/1685258240`. The large file was not downloaded through the manager.
- **The real bundle in `/home/user/laya-cache`.** The manager's `verify()` matches all five pinned digests. `load()` then
  answered a billing ticket with `billing`, confidence 0.96. This is an opt-in test (`COMPANYOS_REAL_LAYA=1`).
- **Inside the packaged app.** The same load and answer ran from the unpacked Linux app's `app.asar`, in Electron 45.1.0
  (Node 24.22.1), both in a real Electron main process and in Electron's node mode. That covers the Electron Node ABI and the
  asar unpack on Linux x64.
- **End-to-end.** The setup step runs in the built app against a local server with a 3 MB bundle: progress, Cancel with the
  partial file kept, Resume with a Range request, five verified files, the ledger rows, Remove from Settings, "Skip, use
  rules", and Delete everything with a download running. The test hook that points the app at the local server is ignored
  in a packaged build.

### Not verified

- macOS and Windows. Nothing was run there, including the disk-space call and loading `onnxruntime-node`.
- A full 1.7 GB download and resume through the manager. The earlier download used the package's own downloader.
- Memory use and load time inside the app. The load took 6 s on this machine, after the checksum pass.
- Laya's accuracy on companyOS decisions, and any use of it by the product.
- That a Hugging Face host other than `huggingface.co` and `*.hf.co` is never needed. Those were the only hosts seen.
