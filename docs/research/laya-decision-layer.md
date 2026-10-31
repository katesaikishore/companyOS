# Laya as a local decision layer

Status: design only. Nothing is downloaded, and no dependency is added. Two decisions are waiting on the owner (see
"Approvals needed").

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

1. Adding `@receptron/laya` 0.2.0 (MIT) and its `onnxruntime-node` dependency.
2. Downloading the 1.69 GB bundle, which is needed to test and to compute the SHA-256 pins.
3. Computing and pinning the SHA-256 digests. This requires that one-time download.
4. Choosing the onboarding offer (recommended) or first-use only.

## Not done

- No accuracy testing of Laya on companyOS decisions.
- No measurement of the real footprint on the three platforms.
- No Electron packaging trial.

## Verified pins and smoke test

Added 2026-10-31 after the owner approved the dependency and the download. The status line at the top describes the
state before this section. The dependency is now in `apps/desktop/package.json`. The bundle is in
`/home/user/laya-cache` on the machine where this was run, outside the repo. No app code calls Laya yet.

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
