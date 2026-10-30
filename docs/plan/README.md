# companyOS Twin: plan

**Status:** Draft v0.1, 2026-10-30. Planning only; no application code yet.
**Working name:** companyOS Twin.
**Research base:** [`docs/research/`](../research/) (five tracks, each with sources, key decisions, risks and an "unverified" list).

A three-architect design panel is still running. Its synthesized plan will replace this overview as v0.2 when it completes.

---

## 1. Summary

companyOS Twin is a desktop app for macOS, Windows and Linux. It watches, locally and passively, how a person works across apps, windows, browser tabs and repeated action sequences. From that it builds a **twin**: a model of the person's work patterns, routines and habits. It then offers automations for the repetitive parts and, once an automation has earned it, runs that automation on its own.

Three principles shape everything else:

1. **Raw data stays on the device.** Capture, storage, redaction and most reasoning run locally, in an encrypted store that only the user holds the key to.
2. **The employee owns the twin.** A company can roll the app out, but it sees only aggregated, differentially private statistics and automations that employees choose to publish. There is no per-person score, ranking, idle-time metric or keystroke metric.
3. **Autonomy is earned, not granted.** Every automation starts as a suggestion. It can run on its own only after a streak of verified successes, and only if its effects are local and reversible. Money, outbound messages, deletion and permissions always need approval.

## 2. Decision log

| # | Decision | Choice | Source |
|---|---|---|---|
| D1 | Who it serves | Individuals and companies. Each employee owns their twin. | Product owner |
| D2 | Where AI runs | Hybrid. Local models do capture, redaction and classification. Redacted, abstracted traces go to Claude for synthesis and repair. | Product owner |
| D3 | Autonomy in v1 | Earned. Suggest and one-click run first; promotion to unattended runs after a success streak. | Product owner |
| D4 | Desktop shell | Electron with a TypeScript core engine. Chosen by the product owner over Tauri. Per-OS native capture helpers are the target after the spikes. | Product owner; `os-capture.md` |
| D5 | Process model | The twin runs in the user's GUI session, never as a Windows Service or LaunchDaemon. MVP: inside the Electron main process. Target: a separate headless agent once the spikes pass. | `os-capture.md` |
| D6 | Capture modality | Text-first (accessibility, UI Automation, window and browser events). Screenshots and OCR are opt-in and off by default. | `os-capture.md`, `prior-art.md` |
| D7 | Keystrokes | Never record key contents. Only counts, shortcut chords and dwell time. Secure fields are skipped. | `os-capture.md`, `privacy-legal.md` |
| D8 | Event store | Own encrypted SQLite (SQLCipher), mapped onto OCEL 2.0. | `understanding-ml.md` |
| D9 | Automation form | Compile each routine into a typed, versioned workflow graph. The LLM proposes and repairs; it does not drive every run. | `automation-autonomy.md` |
| D10 | Execution order | API and MCP first, then OS-native, browser DOM, accessibility tree, and vision last. | `automation-autonomy.md` |
| D11 | Safety gate | A deterministic local policy engine decides before every step. The LLM is never the final judge of its own safety. | `automation-autonomy.md` |
| D12 | Company analytics | Only k-anonymous (k ≥ 10) differentially private aggregates, over secure aggregation. | `privacy-legal.md`, `prior-art.md` |
| D13 | Cloud model | Claude Opus 5.5 for synthesis and repair, under zero data retention where the org qualifies. Fable 5.x is excluded because it requires 30-day retention. | `understanding-ml.md`, `privacy-legal.md` |
| D14 | Product positioning | Do not compete with platform computer-use agents. Win on passive, cross-OS discovery and an employee-owned twin. | `prior-art.md` |

## 3. What "anonymous" can honestly mean

The product owner asked for anonymous profiling. The research changes how that has to be described, so this section comes first.

A twin of one person is personal data. It is profiling of an identifiable person under GDPR Art. 4(4), and pseudonymised data is still personal data. Calling the twin "anonymous" would be false, and the FTC has punished misleading "anonymized" claims (the Avast order). The defensible wording is:

> **Private and pseudonymous by design. Anonymous aggregates for the company.**

The model has three layers:

| Layer | Who sees it | Form | Status |
|---|---|---|---|
| **Twin** | The owner, on their device | Encrypted SQLite, pseudonymous device and object IDs, no raw screen content | Private. Not anonymous. |
| **Cloud calls** | Anthropic (under ZDR) | Abstracted traces only: app and action tokens, URL templates, pseudonyms, parameter types. Never values or screens. A preview is shown first. | Minimised and pseudonymous. A ledger shows the owner every outbound call. |
| **Employer** | Company admins | k ≥ 10 cohorts, differentially private, over secure aggregation. Only about workflows and apps, plus automations people publish. | Anonymous to the recipient, as far as the recipient can tell. Re-identification risk is tested. |

Consequences:
- The legal basis for the employer side is the employer as controller of the deployment, with legitimate interests plus a works agreement. Joint-controller exposure still exists even with on-device processing (`privacy-legal.md`).
- Behavioural signals such as typing cadence or mouse dynamics are never used to infer emotion, focus or stress. That would risk the EU AI Act Art. 5(1)(f) emotion-recognition ban in the workplace.

## 4. Architecture

```
 ┌──────────────────────────┐   local IPC (Unix socket / named pipe, per-install token)
 │ companyOS UI (Tauri 2)   │◄──────────────────────────────────────────────┐
 │ on demand, tray-based    │                                               │
 └──────────────────────────┘                                               ▼
                                              ┌────────────────────────────────────────────┐
 ┌──────────────────────────┐  native msg      │ twin-agent (Rust daemon, user GUI session) │
 │ Browser extension (MV3)  │─────────────────►│  capture · redact · segment · twin ·       │
 │ Chrome · Edge · Firefox  │                  │  automation runtime · policy engine        │
 └──────────────────────────┘                  │                                            │
                                               │  SQLCipher store   local model (OS / GGUF) │
 ┌──────────────────────────┐  AX / UIA /      └────────────────┬───────────────────────────┘
 │ OS signals               │  AT-SPI / events                  │ opt-in · redacted · allowlisted
 └──────────────────────────┘─────────────────►(twin-agent)     ▼
                                                   ┌──────────────────────────────┐
                                                   │ Claude API (ZDR, Batches)    │
                                                   │ synthesis · repair · naming  │
                                                   └──────────────────────────────┘
 Company mode:  twin-agent ──DP aggregates, k ≥ 10, secure aggregation──► org dashboard
```

**Processes**
- **twin-agent.** A headless Rust daemon (tokio). It runs as a per-user LaunchAgent or login item on macOS (registered with `SMAppService`), as a per-user logon task on Windows, and as a `systemd --user` unit on Linux. It does capture, redaction, storage, understanding and automation execution. It stays alive when the UI is closed.
- **companyOS UI.** A Tauri 2 tray app. It connects to the agent over local IPC and is created on demand.
- **Browser extension.** MV3, for Chrome, Edge and Firefox. It talks to a native-messaging host installed system-wide, so it survives enterprise policy. Safari is deferred.

**Why not a Windows Service or a LaunchDaemon:** Session 0 cannot see windows or input. The agent has to live in the user session.

**macOS TCC attribution (needs a spike):** permissions follow the "responsible process". The plan is to ship the agent as a helper embedded in the main bundle, signed with a stable Developer ID designated requirement. Changing the bundle ID, team, helper path or designated requirement silently resets grants. This is the first spike (S1).

**Storage tiers**

| Tier | Content | Retention |
|---|---|---|
| L0 | Raw signals (transient) | Hours |
| L1 | Normalized events, pseudonymised | Rolling 30–90 days |
| L2 | Episodes and segments | About 1 year |
| Twin | Graph, procedures, rhythms | Versioned. Under about 50 MB. Rebuildable from L1. |

Encryption: a SQLCipher database. The key is wrapped by the Secure Enclave (macOS), TPM (Windows) or Secret Service (Linux) and held only by the user. Deletion is crypto-shredding.

## 5. Capture

### 5.1 MVP capability matrix

| Signal | macOS | Windows | Linux X11 | Linux Wayland (GNOME, KDE, wlroots/COSMIC) |
|---|---|---|---|---|
| Active app and window | `NSWorkspace` notifications, AX | `SetWinEventHook` (foreground, name change, focus) | EWMH | KWin script (KDE); GNOME shell extension; wlroots `ext-foreign-toplevel-list` where supported |
| Focused element and UI text | `AXUIElement` / `AXObserver` (Accessibility) | UI Automation (`IsPassword` for redaction) | Deferred | Deferred (AT-SPI later) |
| Browser URL and title | Extension | Extension | Extension | Extension |
| Input cadence (counts, chords) | `CGEventTap` listen-only (Input Monitoring) | Raw Input (`RIDEV_INPUTSINK`) plus low-level hook watchdog | Deferred | Deferred |
| Idle and lock | System idle and session notifications | System idle and session events | Idle protocol | Idle protocol (per compositor) |
| Screenshots and OCR | Opt-in. ScreenCaptureKit. Re-approval prompts. | Opt-in. Windows.Graphics.Capture. | Deferred | Deferred |

Out of MVP: Safari, Flatpak and AppImage packaging (`.deb` and `.rpm` only), evdev input (rejected because it needs root-equivalent access), AT-SPI.

### 5.2 Permissions to request

| OS | Permission | Why | Friction |
|---|---|---|---|
| macOS | Accessibility | AX tree and focus | One prompt. macOS 27 makes MDM grants user-visible and revocable. |
| macOS | Input Monitoring | Listen-only event tap for counts | One prompt |
| macOS | Screen & System Audio Recording | Only if the user opts into screenshots | Recurring re-approval prompts since Sequoia. Not pre-grantable by MDM. |
| Windows | None for hooks and UIA | Runs per user | Code signing is mandatory. Unsigned keyboard hooks look like keyloggers. |
| Linux | Portal consent (screen, remote input) | Compositor-specific | Compositor extensions break across major versions |

### 5.3 Redaction at source

- Skip `AXSecureTextField`, UIA `IsPassword`, and anything under Secure Event Input.
- Skip private and incognito windows. Skip apps the user excludes.
- Windows with `sharingType = .none` or `WDA_EXCLUDEFROMCAPTURE` render black. Treat them as excluded.
- Never store field values from unclassified apps. Store structure (roles, labels, sizes), not content.
- OCR, when used, runs on demand in memory. Its output is redacted and discarded.

### 5.4 Event schema (illustrative)

```json
{
  "ts": "2026-10-30T09:14:07Z",
  "device": "d_7f3a",
  "subject": "p_91c2",
  "app": "com.microsoft.Excel",
  "window_class": "spreadsheet",
  "action": "copy",
  "context": { "role": "grid", "label": "Invoice lines" },
  "data_ref": "v_0042",
  "dwell_ms": 4200,
  "url_template": "docs.example.com/doc/:id"
}
```

`data_ref` points to a value that is kept separately, is never mined, and is used only to fill parameters for an automation the owner has approved. This follows Leno's split of normalised UI logs into context and data.

### 5.5 Resource budgets (release gates)

- Average CPU under 1%. RSS under 150 MB. No continuous video.
- Disk growth in the MB-per-day range.
- Event-driven capture, not frame-rate capture. Perceptual-hash dedup for screenshots.
- Heavy work (OCR, local model, mining) runs only on AC power or when idle.

Screenpipe, a benchmark, reports 5–15% CPU and 5–20 GB per month with continuous screenshots and OCR. That is the design we are avoiding. Screenpipe's license also changed on 2026-06-09. It is now a paid commercial license for commercial use, so we treat it as a design reference only.

## 6. Understanding: the twin model

### 6.1 Pipeline

```
capture ─► normalize ─► segment ─► label ─► mine ─► parameters ─► twin update
          (context/     (hard cuts, (local    (Rust4PM,   (aligned    (graph,
           data split)   embedding    model,    prefixspan  data)       procedures,
                         drift)       JSON)     on context)              rhythms)
```

- **Normalize.** Map events to context (app, element role and label, field name) and data (values). Pseudonymise data with a per-device salted HMAC. Mine patterns on context only.
- **Segment.** MVP: hard cuts at idle, lock and meeting boundaries, plus embedding drift. v2: Leno's control-flow back-edge segmentation, with LLM refinement of boundaries. Evaluated on boundary F1 and adjusted Rand index.
- **Label.** An on-device model, with output constrained by JSON schema. Preferred: the OS model (Apple Foundation Models on macOS, Phi Silica on Copilot+ PCs). Fallback on other hardware: Gemma 4 E4B or Qwen3.5-4B (Q4) through llama.cpp. Context windows are small (4K–8K on Apple), so processing is chunked per segment.
- **Mine.** Process discovery with the Rust4PM `process_mining` crate (OCEL 2.0, DFG, Alpha+++). Frequent sequences with PrefixSpan or BIDE. Frequent does not mean automatable, so candidates are scored on repeatability, parameter variance and reversibility.
- **Parameters.** Find which values change between repetitions by aligning context with data.
- **Twin update.** Incremental and idempotent. The twin can be rebuilt from L1.

### 6.2 Storage and search

- One encrypted file: SQLCipher, `sqlite-vec` (pinned version) for vectors, FTS5 for text.
- Embeddings: EmbeddingGemma-300M, truncated to 256 dimensions, int8. About 25 MB per 100K vectors.
- Revisit LanceDB only past about 1M vectors.

### 6.3 Cloud escalation

Escalation is **opt-in**. Only allowlisted abstract traces leave the device. The owner sees a preview before each send, and every call is recorded in a ledger the owner can read.

Example of an outbound payload (abstract, no values):

```json
{
  "segment_id": "s_19",
  "steps": [
    { "ctx": "app:spreadsheet|action:copy", "param": "range" },
    { "ctx": "app:crm|action:paste", "param": "record_id" }
  ],
  "freq_14d": 14,
  "task": "propose_automation"
}
```

Model use:
- **Claude Opus 5.5** (`claude-opus-5-5`): synthesis, naming, repair. Used through the Batches API (50% cost) for nightly work and through prompt caching for interactive work. Zero data retention is expected to apply, but this must be confirmed for our org (spike S6). Its computer toolset is a fallback only.
- **Sonnet 5.5 / Haiku 5.5**: cheaper tiers to evaluate for bulk labelling. The product owner decides the final choice.
- **Fable 5.x**: excluded. It requires 30-day retention and is not ZDR-eligible.
- Structured outputs for every machine-read response. Forced `tool_choice` is not used on Opus 5.5, so tools are declared `strict` with `tool_choice: auto`.

### 6.4 Evaluation

- Segmentation: boundary F1, adjusted Rand index.
- Routine detection: precision of automation candidates, measured as the share the owner accepts.
- Parameter extraction: accuracy against owner corrections.
- Label collection: a one-tap "that's a task" control. Corrections are the training signal. Minimal friction matters more than label volume.
- Synthetic trace corpus for CI. Real traces are not used for development.

## 7. Automation and earned autonomy

### 7.1 Representation

An automation is a typed, versioned workflow graph with these node types: `observe`, `act`, `check` (postcondition), `approve`, `branch`, and `agent_step` (a bounded LLM step with a typed output). Each `act` node stores several fallback locators, from the most reliable tier to the least.

```yaml
automation: copy_invoice_to_crm
version: 3
params: { invoice_range: string, crm_record: string }
steps:
  - act: spreadsheet.copy_range   # tier 1: API / file
    args: { range: $invoice_range }
  - act: crm.paste_record         # tier 2: browser DOM
    locators: [dom:#record-$crm_record, a11y:Record/Name]
  - check: crm.record_has_value   # postcondition
  - approve: if external_comm
```

### 7.2 Execution tiers

Each step uses the highest tier available:

1. **API and MCP.** Immune to UI changes. Use the MCP 2026-07-28 spec, with back-compat for 2025-11-25 servers. Do not adopt the deprecated Roots, Sampling or Logging features. Treat tool annotations from servers as untrusted and classify effects independently.
2. **OS-native.** AppleScript and JXA on macOS, PowerShell and UI Automation on Windows, D-Bus on Linux.
3. **Browser DOM**, through the extension.
4. **Accessibility tree.**
5. **Vision.** The Claude computer toolset (`computer_toolset_20260801`, GA on the Claude API, no beta header). A fallback only, in a sandboxed browser profile or VM with an egress allowlist, always under human confirmation at MVP.

Linux input injection uses libei through the `xdg-desktop-portal` RemoteDesktop portal (GNOME 46+, KDE 6), with X11 XTest as a fallback. It does not use ydotool or uinput, because those bypass consent.

### 7.3 Autonomy levels

| Level | Behaviour | Available |
|---|---|---|
| L0 Observe | Passive capture and understanding only | MVP |
| L1 Suggest | "I noticed you do this 14 times a week, about 3 hours saved." Dismissable. | MVP |
| L2 Draft | Prepared end to end, not executed | MVP |
| L3 One-click run | Runs with the owner present and confirming | MVP ceiling |
| L4 Autonomous, local and reversible | Runs unattended. Effects are local and reversible only. | Beta, after a promotion gate |
| L5 Autonomous, external | Sends, writes to third-party systems | v2 only |

**Promotion gate (L3 → L4)** — design recommendations, not sourced standards:
- At least 10 supervised runs, and at least 25 runs over 14 days.
- At least 99% postcondition pass rate.
- Zero owner corrections or reverts in the window.
- Effects classified as local and reversible.

**Demotion:** any failed postcondition, or any owner revert, drops the automation to L3 immediately.

**Outbox delay:** external effects wait 30–60 seconds in an outbox that the owner can cancel. Irreversible effects cannot be undone, so the delay and the approval gate are the only mitigation.

### 7.4 Policy engine

A deterministic local policy, written in Cedar (`cedar-policy` crate) or OPA and evaluated before every step. A hard floor always requires approval for:
- money and payments
- external messages to new recipients
- deletion
- credentials and permission changes
- installs and accepting terms

Rule of Two: an agent step that reads untrusted content may not also hold external-communication capability in the same session.

### 7.5 Safety

- **Prompt injection** from screen and web content cannot be fully prevented, according to NCSC, OpenAI and Anthropic. Mitigations: fixed control flow compiled before untrusted content is seen, the policy floor above, and the Rule of Two.
- **Credentials** go into the OS keychain (`keyring` 4.2.0). The executor injects them into fields or headers. They never appear in prompts, logs or screenshots, and password fields are masked.
- **Verification:** every write has a postcondition check.
- **Undo and checkpoints** wherever the target supports them.
- **Kill switch:** a global hotkey and a menu item stop all automations.
- **Rate limits** per automation and per target system.
- **Audit log:** local, encrypted, and redacted. Audit logs and evidence screenshots are personal data too.

### 7.6 Self-repair

When a locator breaks, the runtime tries the fallback locators, then asks the cloud model for a repair. A repair is scope-bounded: it may change locators but not the set of effects. At L4 and above, a repair needs re-approval. Silent drift is the main risk here.

## 8. Company mode

### 8.1 What admins can and cannot do

| Admins **can** | Admins **cannot** |
|---|---|
| Set deny floors and allowlists | Read any twin data |
| Approve connectors | See the contents of any employee's automations |
| Disable the agent remotely | Raise any employee's autonomy level |
| Read DP aggregates over cohorts of 10 or more | See any per-person metric, score, ranking or idle time |
| Share automations from a library that employees publish | Require the personal twin. It is voluntary, with no penalty for refusing. |

The employee holds the autonomy levels. Admins hold a safety brake, not a steering wheel.

### 8.2 Aggregates

- Differentially private statistics over secure aggregation (DAP/Prio3 with OpenDP). Minimum cohort k ≥ 10. The retention and epsilon budget are design recommendations and need legal review.
- Subjects of aggregates: workflows and apps used, and automation adoption. Not individuals.
- Employees preview what would be shared before it is sent.

### 8.3 Compliance pack

- DPIA and legitimate-interests assessment.
- Works agreement (Germany: BetrVG §87(1) no. 6 applies to any system objectively able to monitor, so a works agreement is needed before rollout even for aggregate-only designs). A model Betriebsvereinbarung ships with the product.
- Notices for New York, Connecticut and Delaware. An Art. 26(7) notice. A CCPA risk-assessment template.
- France: a CSE information pack.
- Agent state visible to employees at all times.

### 8.4 EU AI Act positioning

- The intended purpose is personal task automation. Worker evaluation is excluded in both the terms and the code.
- Annex III 4(a) and 4(b) (employment, worker monitoring) become high-risk from **2 December 2027** under Regulation (EU) 2026/1744. Any organisational analytics must meet those standards before then.
- Art. 5(1)(f) (emotion recognition in the workplace) has applied since February 2025. No emotion, focus or engagement inference.
- Art. 22 GDPR: any automation that makes a decision about a person is out of scope.

### 8.5 Deployment

- macOS: notarized `.pkg` built with `productbuild`, Developer ID signed, with PPPC profiles, the macOS 27 declarative Privacy defaults, a managed login item, and a Team ID allowlist.
- Windows: signed MSI or `.intunewin`, optional MSIX or sparse identity. Chrome and Edge policy: `ExtensionInstallForcelist` and `NativeMessagingAllowlist`.
- Updates are controlled by MDM in company mode, so code identity and TCC grants stay stable.

## 9. Technology stack

| Area | Choice | License and status |
|---|---|---|
| Core engine | TypeScript (`packages/core`), Zod schemas, Node crypto | Ours |
| Desktop shell and UI | Electron 45 (Chromium and Node). Sandboxed renderer, contextBridge, strict CSP. | MIT |
| Screen capture (opt-in) | `xcap` | Apache-2.0 |
| Input events | `rdev` | MIT. Fragmented forks; pin and validate. |
| Accessibility | Platform AX and UIA bindings (`windows-rs`, `uiautomation`) | Verify versions in spike |
| Process mining | `process_mining` (Rust4PM) | MIT / Apache-2.0, 0.x: pin |
| Pattern mining | PrefixSpan / BIDE implementation | Verify |
| Local store | SQLite + SQLCipher, `sqlite-vec` (pinned), FTS5 | Verify SQLCipher terms |
| Secrets | `keyring` 4.2.0 | Verify |
| Policy | Cedar (`cedar-policy`) or OPA | Verify |
| Local models | Apple Foundation Models, Phi Silica, llama.cpp with Gemma 4 E4B or Qwen3.5-4B (Q4) | Verify model licenses before shipping |
| Embeddings | EmbeddingGemma-300M, 256-dim int8 | Verify |
| Cloud | Claude API: Opus 5.5 (ZDR where eligible), Batches, prompt caching, structured outputs, `inference_geo` | Commercial API |
| Browser | MV3 extension and native-messaging host | Chrome, Edge, Firefox |
| Packaging | macOS: notarized `.pkg` and `.dmg`. Windows: signed MSI. Linux: `.deb`, `.rpm`. | Azure Artifact Signing or OV certificate on cloud HSM. Certificates are valid for at most 460 days from March 2026. |

**Licensing rule:** no AGPL or GPL dependency may enter the shipped client. This rules out PM4Py (AGPL-3.0, research only), SPMF (GPL, research only), the OmniParser icon-detection weights (AGPL), workflow-use (AGPL), OpenRecall (AGPL) and Windrecorder. Decide on day 1 whether the client is open (MIT/Apache core with a commercial control plane, the OpenAdapt model) or closed.

### 9.1 Repository layout (proposed)

```
companyos/
  docs/
    plan/                     this plan
    research/                 research tracks, 2026-10-30
  crates/
    twin-core/                event schema, redaction, encrypted storage
    twin-capture/             per-OS adapters: macos, windows, linux_x11, linux_kwin, linux_gnome, linux_wlroots
    twin-understand/          normalization, segmentation, mining, twin model
    twin-automate/            workflow DSL, compiler, runtime, policy engine
    twin-ipc/                 local IPC between agent and UI
    twin-agent/               daemon binary
  apps/
    desktop/                  Tauri UI
    browser-ext/              MV3 extension and native-messaging host
  services/                   company aggregation service (later)
  tests/privacy/              leak tests, redaction canaries, anonymity tests
  tools/                      evaluation harness, synthetic trace generator
```

### 9.2 Build, CI and testing

- Cross-OS CI matrix: macOS (latest and n-1), Windows 11, Ubuntu (X11), Fedora (KDE Wayland), Ubuntu (GNOME Wayland).
- Privacy tests run on every build: secure-field canaries, a planted-secret leak test (no canary may appear in any outbound payload), and a cloud-payload schema test.
- Signed builds in CI only. Unsigned keyboard hooks are blocked by AV.

## 10. Roadmap

Team size is an assumption for planning: four engineers (two Rust, one front end, one ML and privacy). The product owner should confirm it.

### Phase 0: spikes (about 4–6 weeks)

These must pass before the MVP is committed to.

| Spike | Question | Pass criterion |
|---|---|---|
| S1 | Does an embedded `SMAppService` helper inherit TCC grants across updates? | Grant survives an update, tested on a real notarized build |
| S2 | Do Windows low-level hooks plus a watchdog keep counts flowing? Does UIA give usable text on Chromium apps? | Watchdog recovers from forced hook removal within 1 s |
| S3 | How good is AX coverage across the top 30 apps (Electron, Office, browsers, Slack, Teams)? | At least 70% of the top apps yield usable structure, with `AXManualAccessibility` where needed |
| S4 | Can KWin-script and GNOME-extension prototypes report window, focus and idle? | Works on GNOME 46+ and KDE 6 |
| S5 | Can a 4B model label segments on an 8 GB laptop without hurting battery or thermals? | Labels at target accuracy, under the CPU budget |
| S6 | Is zero data retention available for `claude-opus-5-5` in our org? Is `inference_geo` honoured? | Written confirmation from Anthropic |
| S7 | Can we generate a synthetic trace corpus and a labelled set for segmentation and mining? | Corpus covers ten routine types with known ground truth |

### Phase 1: MVP (single user, macOS and Windows)

- Text-first capture on macOS and Windows. Browser extension for Chrome and Edge.
- Local encrypted twin. Segmentation and routine detection.
- L1 suggest, L2 draft and L3 one-click run, using the API, OS-native and browser-DOM tiers.
- No cloud escalation, or opt-in only behind the allowlist.
- No company mode.

**Exit:** 20 pilot users. Some accepted suggestions in week one for most of them. Zero raw-content egress in the privacy tests. Budgets met.

### Phase 2: Beta (Linux, cloud escalation, L4)

- Linux: KDE via KWin script, GNOME via shell extension, wlroots/COSMIC where possible. `.deb` and `.rpm`.
- Cloud escalation with ZDR and allowlist. Nightly Batches synthesis.
- L4 autonomy for local, reversible effects after the promotion gate.
- MCP tools. Automations exported as MCP tools or agent skills.

**Exit:** the promotion gate has been exercised on real automations. Zero incidents of unapproved external effects.

### Phase 3: v1 (company mode pilot)

- DP aggregates, admin controls, MDM packages, compliance pack.
- One pilot company in a jurisdiction with works-council rules, with a signed works agreement.
- Automation library that employees publish to.

**Exit:** signed works agreement, DPIA approved, a pilot with no per-person data leaving the device.

### Phase 4: v2

- Vision fallback through the computer toolset, in a sandbox.
- Leno's segmentation with LLM refinement.
- libei input on Wayland.
- L5 for external effects, with outbox and approval.
- Safari.

## 11. Success metrics

| Area | Metric | Target |
|---|---|---|
| Product | Accepted suggestions per active user per week | Set after pilot baseline |
| Product | Automations still in use at 30 days | Set after pilot baseline |
| Privacy | Raw content in outbound payloads | Zero, enforced by CI |
| Privacy | Secure-field and private-window canary pass rate | 100% |
| Performance | Average CPU | Under 1% |
| Performance | RSS | Under 150 MB |
| Automation | Postcondition pass rate at L4 | At least 99% |
| Automation | Owner reverts per 100 runs | Tracked, trend down |
| Trust | Opt-out and uninstall rate after the first 2 weeks | Tracked |

## 12. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Platform commoditisation: Microsoft Recall and Copilot Actions, Anthropic computer use and Cowork, Google Gemini Agent, Apple Siri | Lower differentiation | Compete on passive, cross-OS discovery and an employee-owned twin (D14). Export as MCP tools. |
| Privacy incident (an unencrypted local store like Recall v1, or a local API exfiltration like the one reported against Screenpipe) | Destroys trust | Encrypted store, crypto-shredding, leak tests in CI, independent review before beta |
| Re-identification from behavioural sequences in small teams | Breaks the anonymity promise | k ≥ 10, DP noise, no per-person endpoint, review of published automations |
| PII filters are unreliable (Recall still captured cards and passwords in Aug 2025 tests) | Leaked data | Structure-only capture by default, allowlisted cloud schema, fail closed |
| Prompt injection in autonomous runs | Unintended actions | Compiled control flow, policy floor, Rule of Two, no LLM as final judge |
| macOS screen-recording friction and macOS 27 consent changes | Low onboarding conversion; no fleet-wide silent install | Text-first capture; consent UX; MDM declarative defaults |
| TCC attribution breaks on updates | Capture silently stops | S1 spike; stable signing identity; MDM-controlled updates in company mode |
| Windows hooks silently removed; AV and EDR quarantine | Missing signals; agent blocked | Watchdog; signed builds; Raw Input; vendor allowlisting in company mode |
| Wayland fragmentation (per-compositor extensions) | High maintenance | Scope to KDE, GNOME and wlroots for MVP; X11 fallback; defer input |
| Electron and canvas apps expose poor accessibility trees | Brittle automations | Vision fallback, locator fallbacks, AX coverage audit (S3) |
| Self-repair changes behaviour silently | Wrong actions at scale | Scope-bounded repairs; re-approval at L4 and above |
| Notification fatigue | Churn | Frequency caps; acceptance tracking; suggestions batched |
| Employee backlash, bossware perception | Company deals stall | No individual metrics; employee ownership; visible agent state |
| Regulatory scope creep: GDPR, AI Act, works councils, Quality Jobs Act proposal | Blocked rollout | Legal review before v1; purpose limitation in terms and code |
| Cloud LLM ZDR eligibility varies by model and feature | Forced retention | Verify (S6); fall back to on-device only |
| Dependency and license drift (Screenpipe relicensed; AGPL components) | Forced rewrite or open-sourcing | License gate in CI; pinned versions; no AGPL/GPL in client |
| Small local models invent steps | Wrong procedures | Typed outputs; human confirmation; promotion gate |
| Battery, thermal and RAM load from a 2.5–3 GB model | Uninstalls | Run only when idle and on AC power |

## 13. Open questions for the product owner

1. **Which OS ships first?** This plan assumes macOS and Windows for MVP, with Linux in Beta.
2. **Team size and budget.** The roadmap assumes four engineers.
3. **Open or closed client?** Research recommends deciding now. An open MIT/Apache client with a commercial control plane is the OpenAdapt model.
4. **Where does company-mode revenue come from?** Seats, a control plane, or both.
5. **First company-mode market.** A works-council jurisdiction (Germany, France) is the hardest, so it either comes first as the proof point or last as the scale market.
6. **Legal wording.** Counsel should confirm "private and pseudonymous by design; anonymous aggregates" before any marketing uses the word "anonymous".
7. **Legal hold and e-discovery.** User-held keys conflict with an employer's legal-hold duties in regulated industries. This needs a policy decision.
8. **Windows signing eligibility.** Azure Artifact Signing has geography and tenure requirements. Otherwise an OV certificate on a cloud HSM is needed.

## 14. Unverified items

The research files list everything they could not confirm. The most important ones for this plan:

- macOS screen-recording re-approval cadence on Tahoe and macOS 27: sources conflict.
- Whether PPPC can pre-grant Input Monitoring. Third-party tables say it can only be denied.
- TCC attribution for `SMAppService` helpers. Based on forum statements from Apple DTS, not formal docs. S1 settles it.
- UIPI behaviour for low-level hooks against elevated windows. General knowledge only.
- Tauri WiX version (v3 or v6), and whether `tauri-plugin-updater` self-updates `.deb` and `.rpm`.
- Apple on-device model context size (4K or 8K tokens).
- Zero data retention for Opus 5.5 and Sonnet 5.5, which is inferred from the docs. Confirm with Anthropic (S6).
- California AB 1331 and Maine LD 61 scope. Both are home-monitoring laws to check against remote work.
- The k ≥ 10 threshold, retention limits and epsilon budget are design recommendations, not legal requirements.
- Benchmark figures (Tauri vs Electron RAM, screenpipe CPU and storage, OSWorld scores) come from vendor sources and disagree with each other.
- Promotion thresholds in §7.3 are design recommendations, not sourced standards.

Full lists: [`os-capture.md`](../research/os-capture.md), [`prior-art.md`](../research/prior-art.md), [`privacy-legal.md`](../research/privacy-legal.md), [`understanding-ml.md`](../research/understanding-ml.md), [`automation-autonomy.md`](../research/automation-autonomy.md).

## 15. Next steps

1. Run spikes S1–S7 (§10).
2. Replace this overview with the design panel's synthesized plan (v0.2), once it completes.
3. Get legal review on §3 and §8 before any pilot.
4. Choose open or closed client (§13, question 3). This gates the repository and license setup.

## 16. Implementation status (MVP build)

The MVP is built on branch `work-twin-app`. It follows this plan with these deliberate deviations:

| Plan | MVP | Why |
|---|---|---|
| Rust core and Tauri UI | TypeScript core, Electron UI | Product owner chose Electron. One language across core and UI. |
| Headless per-user agent | Twin engine inside the Electron main process | Simpler to ship first. The agent split waits for spike S1. |
| Native capture (AX, UIA, AT-SPI) | Polling adapters: `osascript`, PowerShell `GetForegroundWindow`, `xdotool` | Native helpers need the spikes. Polling is measurably more expensive, especially on Windows. |
| SQLCipher store | Record-level AES-256-GCM over an append-only log, key from OS keychain | SQLCipher needs a native build on all three OSes first. |
| Browser extension | Not built. The engine accepts URL templates. | Separate work item. |
| Keystroke counts | Not captured | Needs the native helper. |
| Wayland | Reported as unavailable | Needs a compositor extension (spike S4). |

What the engine tests cover (`packages/core/test`, 61 tests): redaction and privacy at ingest, store encryption and tamper detection, segmentation, routine mining, compilation, policy evaluation order, runner outcomes, the promotion gate and demotion, the cloud trace schema, the ledger, and an end-to-end agent run. The desktop smoke test checks that the page renders and the bridge answers.

Not yet done: signing and notarisation, real icons, a manual pass on each OS against real apps, and company mode.
