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
