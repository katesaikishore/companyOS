# Vision fallback for capture: proposal

**Status:** Proposal only. Nothing is built. Blocked on the model decision in section 4.
**Date:** 2026-10-31
**Plan references:** §5.1 capture matrix, §5.3 redaction at source, §5.5 resource budgets, §7.2 execution tiers, §15a open models only.
**Research references:** [understanding-ml.md](./understanding-ml.md), [os-capture.md](./os-capture.md), [privacy-legal.md](./privacy-legal.md), [automation-autonomy.md](./automation-autonomy.md).

## 1. Problem and scope

The capture design is text-first (plan D6). Accessibility (AX) on macOS and UI Automation (UIA) on Windows give roles, labels and structure, and the event schema in §5.4 depends on them. Some screens give little or none of that: canvas apps, remote desktops and poorly exposed Electron apps. The plan's risk table already names this gap (§12). The research notes one vendor probe in which a code editor exposed 18 UIA elements where OCR found 94.

When AX or UIA is empty, the event log can record only that a window was focused. Automations on those screens are also the most brittle, because execution falls through to the vision tier last (§7.2).

Current state, which limits how far this can be sized:
- The MVP does no native AX or UIA capture. §16 says it uses polling adapters and that the native helpers wait for the spikes.
- Spike S3 (AX coverage across the top 30 apps, pass at 70% or more with usable structure) has not run. Its result decides how often a fallback would run.
- Linux capture is deferred (§5.1), so a fallback would start on macOS and Windows.

**Scope.** This proposal covers observation only: recovering structure from a frame when AX or UIA has none. It does not cover vision computer use to act on a screen. That is plan §7.2 tier 5, a separate decision, and this proposal does not change it.

## 2. Options

| | Option | What touches the frame | Output | Main cost | Fit with the plan |
|---|---|---|---|---|---|
| A | No fallback. Record the window with no structure. | Nothing | Window, app and dwell time only | Blind spots on canvas and remote screens | The default under D6. No pixels at all. |
| B | OCR only, on demand. Platform OCR on macOS and Windows. An open-source OCR engine if Linux is added later. | OCR, in memory | Text lines with positions, then redacted | Text is more sensitive than structure. Accuracy on UI text is not measured. | §5.3 allows "OCR, when used, runs on demand in memory". |
| C | A small open-weight vision-language model, on demand. | Model, in memory | Typed JSON: element roles, boxes, coarse label classes | Model download, RAM, battery and latency. Conflicts with the 150 MB RSS budget as written (§5.5). Needs a runtime per OS. | Allowed only from the open catalogue (§15a). |
| D | A hosted vision service, including the hosted computer-use tool named in §7.2. | Sent to a third party | Anything | Breaks the rule that no data leaves the device | Excluded by §15a. Not an option. |
| E | An OS-provided on-device model with image input. | Model, in memory | Depends on the model | Image input for these models is unverified. The research says image attachments for one OS model arrive only with a beta OS release. | Open question. Check before any choice. |

**Recommendation.** Keep Option A for the MVP. Reopen B or C after spike S3, with one added measure: the share of focus time in windows that give no usable structure, weighted by app. If that share is small, A stays. If it is large, run a timed comparison of B and C on the top apps before choosing.

## 3. Flow for options B and C

1. **Trigger on events, not a timer.** Capture runs on an app or window focus change, or on a click, and only when AX or UIA returns no usable structure for the window. Never at frame rate (§5.5).
2. **Gate before any pixel is read.** No capture when any of these holds: a secure field is focused (`AXSecureTextField`, UIA `IsPassword`); Secure Event Input is on; the window is private or incognito; the app is on the user's exclusion list; or the window is capture-excluded (`sharingType = .none` or `WDA_EXCLUDEFROMCAPTURE`). Each of these windows is treated as excluded (§5.3).
3. **Resource gate.** Run only on AC power or when idle (§5.5), and only if the owner has turned the fallback on.
4. **Capture one frame into memory** with the platform API: ScreenCaptureKit on macOS (it needs Screen Recording permission, which re-prompts) or Windows.Graphics.Capture on Windows. Cap the image size before inference.
5. **Read in memory.** Run OCR (B) or the model (C). No file, no cache and no log.
6. **Validate and strip.** The result must match a fixed schema: element role, bounding box, label class and count. Free-text transcription of on-screen content is dropped. Output that fails validation is discarded, not stored.
7. **Redact what is left.** Labels go through the same redaction pass as §5.3 and privacy-legal §4: deterministic rules first (secret patterns, card-number checks), then the named-entity pass if the team adopts it.
8. **Keep the structure only.** The output becomes L0 and L1 event fields, pseudonymised like other events. The frame is released, and nothing about it is kept.

## 4. Decisions the owner must make

These block the build.

| # | Decision | Options | Recommendation |
|---|---|---|---|
| V1 | Is there any vision fallback in the MVP? | Yes, with B or C. No, Option A. | No, until S3 reports. |
| V2 | If yes, OCR only, or a small model? | B: cheaper and deterministic, but more text exposure. C: structure, but more cost and model risk. | Decide by a timed comparison after S3. |
| V3 | If C, which model family, size class and runtime per OS? | Choose from the open candidates named in the research notes, all in the small multimodal class. Pin each one by SHA-256 (§15a). | The owner picks after the licence review in section 5. |
| V4 | What is the resource ceiling for a model? | §5.5 caps RSS at 150 MB and average CPU at 1%. A local model does not load within 150 MB. (a) A separate, higher ceiling for an on-demand model process, set by the owner. (b) No local model. | The owner sets the ceiling or chooses (b). |
| V5 | Accept a model download at setup? | The size on disk, and a model-download entry in the network ledger (§15a). | The owner confirms the size once it is measured. |
| V6 | Accept the residual memory risks in section 6, or fund the mitigations? | Accept, or add mitigation work. | The owner decides. |

Measurements needed before V2 and V3 are final:
- The share of focus time without usable structure on the S3 apps (Electron, Office, browsers, Slack, Teams).
- For each candidate: accuracy on a labelled set of those screens (the S7 corpus), RSS, CPU, battery use and latency on an 8 GB laptop (the S5 test).

## 5. Licence review needed

Before any model or OCR engine enters the product, counsel or the licence owner should check:

1. **Model weights.** Apache-2.0 or MIT only, not gated, with the licence file shipped with the weights. Custom-licence model families are excluded (§15a). Read any acceptable-use terms for on-device use in a commercial product.
2. **Model card and training data.** Record what the card says about training data and any restricted source. Flag anything unclear to counsel.
3. **Runtimes.** llama.cpp, MLX-based runtimes and ONNX Runtime each carry a licence and notice duty for the installer.
4. **OCR.** Platform OCR APIs fall under the OS platform terms. An open-source OCR engine on Linux needs its own check, and Linux is deferred anyway.
5. **Copyleft.** No AGPL or GPL component may enter the shipped client (plan §9). The research excludes an icon-detection weight set under AGPL, and this proposal does not use it. Any UI element detector needs the same check.
6. **Gates.** Add each model and runtime to the CI licence gate (plan §12) and to the pinned-digest catalogue (§15a).
7. **Sign-off.** Counsel confirms the licence position in writing before any model ships in the installer. The owner arranges this. The plan asks for legal review before any pilot (§15, step 3).

This section is a checklist for a lawyer, not legal advice.

## 6. Privacy limits

These rules hold for every option. Each should have a test (section 7).

1. **No screenshot is stored.** Pixels exist only in memory for one call. They are not written to disk, the store (L0 to L2 and the twin), logs, crash reports, caches, temp files, the clipboard or any network request. No frame is kept as audit evidence. The research flags evidence screenshots as sensitive personal data.
2. **Gates first.** The section 3 gates run before the frame is read. Secure fields, private windows, excluded apps and capture-excluded windows produce no capture call at all (§5.3).
3. **Structure, not content.** The output is roles, boxes, label classes and counts. Field values from unclassified apps are never stored (§5.3). Values are never mined, and `data_ref` stays separate (§5.4).
4. **Fail closed.** Output that fails the schema or the redaction pass is dropped. Redaction is not a guarantee: the plan says PII filters are unreliable (§12). The gates and the structure-only schema are therefore the main controls.
5. **Off by default, and visible.** Opt-in during setup, off by default, as D6 requires. A visible capture indicator and a global pause hotkey (privacy-legal §4). On macOS the user sees recurring Screen Recording prompts, which MDM cannot pre-grant (§5.2). The design does not work around them.
6. **On demand only.** Event-triggered and rate-limited, on AC power or when idle (§5.5). The research puts screenshot storage at 300 MB to 2 GB a day, one reason for reading on demand.
7. **No inference about people.** The fallback does not infer emotion, focus or attention from what is on screen (plan §3, and the EU AI Act ban on emotion recognition in the workplace).
8. **On-screen text is untrusted.** Model and OCR output is data. It cannot change a policy, enable a step or trigger an action. Any action use stays under §7 and the policy engine.
9. **Company mode.** No frame or frame-derived output leaves the device. Only the k ≥ 10 aggregates in §8 and D12 leave it.
10. **Residual risks the owner must accept or fund.** The OS can page memory to disk or to hibernation files, a runtime may keep copies of its buffers, and crash dumps can capture memory. Mitigations to test: zero buffers after use where the runtime allows; keep frame memory out of crash reports; keep runtime caches off disk. The plan does not promise zero residue, so this stays a stated risk until it is tested.

## 7. Tests the build would need

- **Planted canary.** A known string shown in a window on the fallback path appears in no file, log, database row or crash report after a run. Add it to the leak suite on `origin/twin/privacy-canaries`.
- **Gate.** With a secure field, a private window or a capture-excluded window focused, the capture API is never called (mocked).
- **Schema.** Output containing free text is rejected or stripped.
- **Budget.** RSS and CPU stay within the ceiling set in V4, with the model loaded and idle.
- **Injection.** On-screen text that reads as an instruction changes no policy and starts no step.

## 8. Not verified here

- Model sizes, speed, RAM and battery cost on the target laptops. Not measured.
- Whether any OS-level model accepts image input on the target OS versions.
- Platform OCR accuracy on UI text. Not measured.
- The S3 coverage numbers. Not measured.
- The per-screenshot token counts in the research (about 1,000 to 2,000) come from vendor and secondary sources. They have not been checked here.

## 9. Sources in this repo

- `docs/plan/README.md`: §3, §5.1 to §5.5, §7.2, §8, §9, §12, §15, §15a, §16
- `docs/research/understanding-ml.md`: Inputs; Key decisions
- `docs/research/os-capture.md`: redaction, OCR and accessibility notes
- `docs/research/privacy-legal.md`: §4 technique stack; §5 proposed model
- `docs/research/automation-autonomy.md`: tier 5; risks
