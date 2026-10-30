# Research track: automation-autonomy

# Track: From understanding to automation and safe autonomy ("make it work itself"). Status as of 2026-10-30

## 0. Summary
- **Compile, then run.** A mined routine should become a **deterministic, typed workflow (DSL)**. The LLM's jobs are synthesis, repair and narrow judgment steps. It should not drive every run. All of Stagehand, workflow-use, OpenAdapt, Playwright agents and UiPath have moved to this "record → compile → replay → self-heal" pattern.
- **API-first lifting.** Every step should run on the most reliable tier available: API/MCP > OS-native intents/scripts > accessibility-tree actions > browser DOM > vision computer use.
- **Prompt injection is officially unsolved.** The UK NCSC (Dec 2025) says it "may never be totally mitigated". OpenAI (Dec 2025) says it is "unlikely to ever be fully solved". Anthropic (Nov 2025) measured about 1.4% attack success for Opus 4.5 with its best safeguards against an adaptive attacker and called 1% "meaningful risk". So the design goal is a **small blast radius**, not detecting every injection.
- **Autonomy is earned per automation** and gated by a deterministic policy engine. Some action classes (money, external communication, deletion, credentials or permissions, accepting legal terms) **always require approval**, at every autonomy level.

## 1. Execution layers, ranked by reliability
| Tier | Reliability | Speed/cost | UI-change fragility |
|---|---|---|---|
| 1. Direct API / MCP / OAuth | Highest | ms; cheap | None (versioned APIs) |
| 2. OS-native intents/scripting | High | fast; free | Low to medium |
| 3. Browser DOM (Playwright) | High-medium | ~100 ms per step | Medium (selectors) |
| 4. Accessibility-tree desktop actions | Medium | fast | Medium; coverage gaps |
| 5. Vision computer use (LLM per step) | Lowest, most general | seconds and ~1–2k tokens per step | Robust to layout, error-prone |

**Tier 1: MCP and connectors**
- The current MCP spec is **2026-07-28**, which made the protocol stateless:
  - It removed the `initialize` handshake and `Mcp-Session-Id`, and added a required `server/discover`.
  - Multi Round-Trip Requests (`InputRequiredResult`) replace server-initiated elicitation and sampling.
  - Tasks moved to the `io.modelcontextprotocol/tasks` extension.
  - **Roots, Sampling and Logging are deprecated.** OAuth Dynamic Client Registration is deprecated in favor of Client ID Metadata Documents.
  - Clients MUST validate `iss` (RFC 9207) and key credentials by issuer.
- Build the client against 2026-07-28 with a fallback for 2025-11-25 servers.
- Treat a server's own `readOnlyHint`/`destructiveHint` annotations as *advisory* inputs to policy, never as trusted facts.

**Tier 2: OS-native**
- **macOS**
  - Shortcuts (`shortcuts run` CLI), AppleScript/JXA through Apple Events, and App Intents.
  - Apple Events need the hardened-runtime entitlement `com.apple.security.automation.apple-events`, an `NSAppleEventsUsageDescription`, and per-target-app Automation consent (TCC). Mac App Store sandboxing effectively rules this out, so ship outside the MAS.
  - Synthetic input needs Accessibility (TCC) permission.
  - Apple confirms that macOS 27 surfaces App Intents to Siri through intent schemas. A *system-wide MCP bridge for App Intents* is claimed only by third-party sources. A community tool, `intents-mcp`, already exposes App Intents as MCP tools.
- **Windows**
  - PowerShell, COM for Office, UI Automation (`IUIAutomation`; Rust `windows`/`uiautomation` crates) and `SendInput`.
  - **Gotcha 1, UIPI:** the app cannot drive *elevated* windows unless it declares `uiAccess=true`, is Authenticode-signed and is installed under `Program Files`. Without these, it fails silently.
  - **Gotcha 2:** PowerShell Constrained Language Mode under WDAC/AppLocker on managed PCs.
  - Windows' own agent platform has dedicated **agent accounts** and an **agent workspace**. Users enable it at Settings › System › AI components › Agent tools › Experimental agentic features. Agent connectors are MCP servers governed by an on-device registry. This is a natural sandbox target. The status of the third-party API (Build 2026) is unclear.
- **Linux**
  - App D-Bus interfaces and AT-SPI2 (Rust `atspi` 0.29, zbus-based, async).
  - X11: XTest/xdotool.
  - **Wayland:** use **libei through the xdg-desktop-portal RemoteDesktop portal**, which has a user consent prompt and works on GNOME 46+ and KDE Plasma 6. The wlroots portal lacks libei.
  - Wayland has no way to send input to a specific window; the target must be focused first.
  - `ydotool` (/dev/uinput) needs root or udev rules and bypasses consent. Don't use it by default.

**Tier 3: Browser**
- Playwright, version 1.60 or later (May 2026). The Playwright MCP server works from accessibility snapshots with element refs. `@playwright/cli` (0.1.18) is the token-efficient mode, reportedly about 4× cheaper.
- Test agents (Planner, Generator, Healer) have shipped since 1.56.
- Run automations in a **dedicated persistent Chromium profile per automation or domain**, not the user's main profile.

**Tier 4: Accessibility-grounded agents**
- Microsoft **UFO²** is the reference design:
  - It fuses UIA with vision parsing.
  - It calls the app's API first and falls back to the GUI.
  - It checks UIA preconditions (enabled/visible) before acting.
  - It runs in a picture-in-picture virtual desktop.
- Electron and canvas apps expose poor trees. In one vendor probe, VS Code exposed 18 UIA elements where OCR found 94. A pixel fallback is required.

**Tier 5: Vision computer use**
- Anthropic's current tool is **`computer_toolset_20260801`**. It is GA, needs no beta header, and has 17 member tools including `zoom`; `configs` disables individual members.
  - On the Claude API, Claude 5.5 models accept *only* this version.
  - Older models and Bedrock use `computer_20251124` with header `computer-use-2025-11-24`.
  - Screenshots cost about 1,000–1,800 input tokens each. The limit is 2,576 px on the long edge for Opus 4.7 and later. A stricter per-side limit applies once a request has more than 20 images.
  - **Classifiers automatically scan tool results for injections.**
  - The docs recommend a VM or container, a domain allowlist and human confirmation of consequential actions.
- Other providers: Gemini 3.5 Flash computer use (preview, June 2026) and OpenAI GPT-5.4 desktop control. Keep the model layer provider-agnostic.
- OSWorld-Verified leaders reportedly score about 86–90%, against a 72.36% human baseline. These figures come from aggregators. Benchmark scores ≠ long-tail enterprise reliability.

## 2. Program synthesis from demonstrations
**Pipeline**
1. **Canonical trace.** Record each step against *semantic* targets, never coordinates: app bundle ID plus AX/UIA role, name and path, or URL plus DOM role and text.
2. **Parameter extraction.** Align N instances of the routine. Fields that never change are constants; fields that vary are typed variables (date, amount, email, path). Bind each variable to a source: trigger payload, clipboard, file, or the output of an earlier step.
3. **API-first lifting.** For each UI step, find a Tier 1 or 2 tool with the same effect. For example, "compose in Gmail → send" becomes an MCP send call. SkillWeaver distills trajectories into APIs this way, reporting up to +54.3% on WebArena.
4. **Emit a DSL workflow graph** (versioned JSON/YAML). It contains:
   - trigger, an input schema, and steps with `tier`, `action` and **multi-locator targets** (AX id → role+name → text → relative → visual anchor);
   - `pre`/`post` conditions, an `effect_class` (read / local-write / external-comm / money / delete / permission), `reversible` and a `compensation`;
   - branches and loops, and bounded **`agent_step`** nodes with a goal, allowed tools and a typed output schema.
5. **Validate** in shadow mode and dry-run (§4). Then the user reviews it in a visual editor.

**Prior art**
- Agent Workflow Memory (ICML 2025): +24.6% and +51.1% relative on Mind2Web and WebArena.
- ECLAIR (Stanford, PVLDB): demonstrate → execute → validate on 30 enterprise workflows.
- browser-use `workflow-use`: recording → JSON with variables and an agent fallback; its self-healing is early.
- Stagehand `act()` caching: replay cached selectors without an LLM and self-heal on a miss.
- OpenAdapt: workflow bundles each bound to one surface (browser, desktop, RDP or Citrix); MIT runtime.
- **Agent Skills (SKILL.md)** is an open standard that could package an automation with its scripts for sharing.

**LLM roles:** segmenting and naming routines, inferring parameter semantics, lifting, repair, and `agent_step` judgments such as classifying an email. Each run is otherwise deterministic. This gives predictability, a cost of roughly zero per run, and auditability.

## 3. Graduated autonomy model (per automation)
These levels map to Feng, McDonald and Zhang's "Levels of Autonomy for AI Agents" (Operator → Observer):

| Level | Behavior |
|---|---|
| L0 Observe | Mine the routine only |
| L1 Suggest | Show the opportunity and evidence |
| L2 Draft | Prepare outputs (email draft, filled form, staged files); the user executes |
| L3 One-click run | Show a preview and diff; the user confirms |
| L4 Supervised auto | Runs on its trigger; notification, veto window and undo |
| L5 Autonomous within policy | Digest only; the policy gates still apply |

**How trust is earned**
- Promotion needs all of the following:
  - a verified success streak (suggested: ≥10 runs for L3→4; ≥25 runs over ≥14 days for L4→5);
  - zero user corrections and a ≥99% postcondition pass rate;
  - inputs within the observed distribution;
  - **reversibility class** reversible or compensatable;
  - **blast radius** under thresholds (records touched, recipients, value);
  - **tier cap**: steps that rely on vision cap the automation at L3 in the MVP.
- Each promotion is one click, proposed by the system.
- **Demote** on any failure, user undo, detected UI drift, new out-of-distribution parameter, policy change or credential change.

**Policy engine**
- Deterministic and local, evaluated *before every step*. Options are Cedar (`cedar-policy` Rust crate) or OPA/Rego. It must not be an LLM.
- Inputs: effect class, domain, recipient (new or known), amount, data sensitivity, tier, autonomy level.
- **Hard floor, always requires approval:** payments or purchases; external communication to new recipients or public posting; deletion or overwrite without a backup; credential, permission or security-setting changes; software installs; accepting terms or cookies.
- **Meta's "Agents Rule of Two"** (Oct 2025): a session may hold at most two of {untrusted input, sensitive data/systems, state-change or external communication}.
- **Company mode:** an admin can set *deny floors and allowlists* but cannot force autonomy or read the twin. The employee owns the levels.

## 4. Safety mechanisms
- **Dry-run:**
  - API tier: preview or read-back endpoints.
  - UI tier: a "ghost run" that resolves every locator and precondition and highlights the targets on an overlay without acting.
  - **Shadow mode:** predict the next step while the user works, and compare. This builds trust with zero risk.
- **Verification:** each step's postconditions are checked by AX state, file hash, URL or API read-back, plus checks on the end result. LLM-as-judge is only a secondary check.
- **Undo and rollback** use the saga pattern, not a stack:
  - files go to staging or trash, never a hard delete;
  - optional snapshots (APFS local snapshot, VSS, btrfs/ZFS);
  - **outbox with a send delay** (e.g. 30–60 s) for communications;
  - idempotency keys and compensating actions in the DSL.
  - Research to watch: AgentRewind and WebRollback (2026 preprints).
- **Sandboxing:**
  - a separate browser profile per domain;
  - Windows agent account/workspace where available;
  - VMs for vision-agent runs (Apple Virtualization.framework, Hyper-V/Windows Sandbox, Xvfb containers on Linux, or Windows 365 for Agents in enterprise);
  - an egress allowlist per automation.
- **Credentials:**
  - Store them in the OS keychain through the Rust `keyring` crate (4.2.0: Keychain, Windows native credential store, Secret Service).
  - The *executor* injects a secret straight into the field or the HTTP header. Secrets never appear in prompts or logs, and password fields are masked in screenshots.
  - OAuth scopes are minimal.
  - 1Password's Secure Agentic Autofill (Oct 2025) is the pattern to copy: human approval, then injection into the browser outside the LLM context.
- **Prompt injection from screen or web content** (OWASP Agentic Top 10 2026, ASI01 "goal hijack"):
  - *Architecture is the defense.* The compiled DSL fixes the control flow before any untrusted content is seen, which is CaMeL-like by construction. In CaMeL, a privileged planner works from the trusted query and a quarantined LLM reads the data; it solved 77% of AgentDojo tasks with provable security, against 84% undefended.
  - `agent_step` outputs only typed values and cannot add steps, tools or recipients.
  - Untrusted text is spotlighted (delimiting or datamarking, per Microsoft) and scanned by classifiers (Anthropic's automatic ones, Prompt Shields).
- **Audit log:** append-only and hash-chained, encrypted locally. Each step records the policy decision, autonomy level, inputs as hashes or redacted values, and evidence. The user can export it. In company mode, sharing is opt-in by the employee.
- **Kill switch:**
  - a global panic hotkey, plus a stop button in the tray or menu bar;
  - **any physical user input pauses UI-tier runs**;
  - a circuit breaker after K consecutive failures;
  - an admin policy can disable automations but cannot inspect them.
- **Rate limits:** per automation, per domain and per recipient (actions per minute, runs per day), plus LLM token and spend budgets.

## 5. Self-improving loop
- **Telemetry for every run:** success, failing step, which locator fallback was used, repairs, duration and user edits.
- **Self-repair ladder:** alternate locators → AX re-grounding → LLM visual re-grounding (using the stored step description and the "before" screenshot) → a *patch diff to the DSL* → a verify run.
  - At L4 and above, persisting a patch needs approval and drops the automation one level until it rebuilds its streak.
  - The same pattern appears in Playwright Healer, UiPath Healing Agent, Stagehand and workflow-use.
- **A repair can never widen scope:** no new effect class, domain, recipient or credential.
- **Learning from corrections:** the user's edits to drafts update defaults and rules and are kept as new demonstrations. Induction (AWM-style) uses **only verified-success runs**.
- **Drift detection:** app bundle version, hashes of DOM/AX structure, input distribution.
- **Retirement:** suggest archiving when an automation hasn't been triggered in X days or the observed routine has disappeared. Auto-pause when it keeps failing.

## 6. UX for proposing automations
- **Timing:** at natural breakpoints (task completion, app switch, end of day), never mid-flow. In the CHI 2025 study of proactive assistants, more frequent suggestions lowered acceptance even though productivity still rose.
- **Batching:** a daily or weekly "opportunities" digest and at most one interruptive suggestion per day, with snooze and "never for this".
- **Evidence:** for example, "You did X 14×/week, ~12 min each → ~2.8 h/week". Show 3 real instances, constants vs variables, and a **counterfactual replay** of what the automation would have done last time, with an estimated reliability.
- Offer **Draft (L2) first**. Show a level badge on each automation and promotion nudges ("10 clean runs, let it run automatically?").
- Rank opportunities by time saved × reliability × low risk. Never suggest automations in sensitive categories.

## 7. Recommended architecture and autonomy policy
**MVP**
- Rust core runtime with a DSL compiler and interpreter and a visual editor.
- Tier 1: an MCP client (2026-07-28 plus back-compatibility) with curated OAuth connectors (Google, M365, Slack, Jira, GitHub).
- Tier 2: Shortcuts and AppleScript, PowerShell, shell and D-Bus.
- Tier 3: Playwright in managed profiles.
- Accessibility-tree replay only with verification. Vision computer use is **L3 only**, in a sandboxed browser or VM, with the user present.
- **Autonomy cap L3.** L4 only for read-only or reversible local effects (file organizing to trash, extraction into local sheets).
- Cedar policy with the hard-floor list; Rule of Two; keychain; outbox delay; panic hotkey; pause on user input; audit log.

**v2**
- Full accessibility tier (UIA/AX/AT-SPI) with UFO²-style API-first hybrids.
- Vision fallback nodes in a VM or the Windows agent workspace.
- Self-healing with approval gates; L4/L5 within policy.
- Company admin deny-floors and an org template library of anonymized Skills.
- macOS 27 App Intents/MCP and Windows agent connectors once their availability is confirmed.

## Key decisions
- **Runtime model: does an LLM agent drive every run, or does each automation compile into a deterministic workflow?** → Compile each mined routine into a typed, versioned DSL workflow graph. Use the LLM only for synthesis, naming, parameter inference, repair, and bounded agent_step nodes with typed outputs. — _Runs become predictable, near-zero cost per run, auditable and editable. Control flow is fixed before any untrusted content is seen, which gives CaMeL-like resistance to injection by construction. Stagehand, workflow-use, OpenAdapt, Playwright agents and UiPath have converged on this pattern._
- **Which execution tier each step uses** → API-first lifting. Every step runs on the highest available tier: MCP/API > OS-native > browser DOM > accessibility tree > vision. Each step stores several fallback locators. — _Reliability and cost improve by orders of magnitude at each tier up, and API steps are immune to UI changes. UFO2 and SkillWeaver show gains from preferring APIs._
- **Role of vision computer use (Claude computer_toolset_20260801 and others)** → Use it only as a fallback node or for one-off assisted tasks. In the MVP, cap it at L3 (one-click, user present), in a sandboxed browser profile or VM with an egress allowlist. Keep the model adapter provider-agnostic. — _It is the most general tier but the slowest and costliest (about 1–2k tokens per screenshot) and the most exposed to injection. Anthropic's own docs recommend a VM, allowlists and human confirmation._
- **Policy engine implementation** → A deterministic local policy engine (Cedar via the cedar-policy crate, or OPA) evaluated before every step. A hard-coded approval floor covers money, external comms to new recipients, deletion, credentials or permissions, installs and accepting terms. Enforce Meta's Rule of Two per session. — _An LLM must not be the final judge of its own safety. A deterministic policy is auditable, testable, and cannot be prompt-injected._
- **Autonomy cap for MVP** → Cap at L3 by default. Allow L4 only for read-only or reversible local effects, earned through verified success streaks. L5 waits for v2. — _Trust has to be earned per automation, and the self-repair and rollback machinery has to be proven first. Prompt injection is unsolved (NCSC, OpenAI, Anthropic)._
- **Credential handling** → Store credentials in the OS keychain through the keyring crate (4.2.0). The executor injects secrets directly into fields or headers. Secrets never go in prompts, logs or screenshots (mask password fields). Use minimal OAuth scopes and key tokens by issuer, per MCP 2026-07-28. — _This removes the main exfiltration target from the LLM context. It matches 1Password's Secure Agentic Autofill pattern and the MCP auth hardening._
- **Linux Wayland input injection** → Use libei through the xdg-desktop-portal RemoteDesktop portal (GNOME 46+, KDE 6), with X11 XTest as a fallback. Do not default to ydotool or uinput. — _The portal path carries user consent. ydotool needs root or udev rules and bypasses consent, which conflicts with the privacy positioning._
- **MCP protocol target** → Implement the client against spec 2026-07-28 (stateless, server/discover, MRTR, tasks extension) with back-compat for 2025-11-25 servers. Do not adopt the deprecated Roots, Sampling or Logging features. — _Deprecated features have a 12-month removal window, and the ecosystem is migrating now._
- **Company-mode control split** → Admins can set deny floors, allowlists, connector approval and a remote disable. They cannot raise autonomy, read twin data or see per-employee automation contents. The employee holds the autonomy levels. — _This preserves employee ownership and anonymity while giving IT a safety brake._

## Risks
- Prompt injection via on-screen or web content cannot be fully prevented (NCSC, OpenAI and Anthropic all say so). Any agent_step or vision step that reads untrusted content and holds external-comm capability is exploitable unless the Rule of Two and the policy floor are enforced.
- Accessibility-tree coverage is poor in Electron, canvas and custom-drawn apps. Automations relying on them will be brittle and need vision fallback, which costs more and is less reliable.
- Windows UIPI silently blocks automation of elevated windows unless the binary is signed, declares uiAccess and is installed in Program Files. PowerShell Constrained Language Mode on managed PCs can also break scripts.
- macOS Apple Events and Accessibility need several TCC consents, and Mac App Store sandboxing blocks them. Distribution has to happen outside the MAS, with notarization.
- Wayland fragmentation: the libei/RemoteDesktop portal is missing on wlroots and Hyprland, and there is no per-window input targeting. Linux UI automation will be partial.
- Self-healing can silently change what an automation does. Repairs must be scope-bounded and re-approved at L4 and above, or a drift can cause wrong actions at scale.
- Irreversible external effects (sent messages, payments, third-party API writes) cannot truly be undone. Only delay queues and approval gates mitigate them.
- Over-eager suggestions cause notification fatigue and churn, and acceptance drops with suggestion frequency.
- Vision computer-use cost and latency (about 1–2k tokens per screenshot, seconds per step) can make per-run agent execution uneconomical at company scale.
- Fast-moving platform features (Windows agent workspace, macOS 27 MCP/App Intents, MCP spec revisions) may change or slip, so integrations need abstraction layers.
- MCP servers self-declare tool annotations (readOnlyHint/destructiveHint), and a malicious or buggy server can misreport them. Policy must classify effects independently.
- Audit logs and screenshots of evidence are themselves sensitive personal data. They conflict with the anonymity requirement unless redacted, encrypted, and kept local by default.

## Unverified
- OSWorld-Verified top scores (about 86–90%, e.g. 'Intelligence-Indeed Agent 90.19%') come from aggregator and vendor sites. They were not confirmed on the official leaderboard.
- A system-wide MCP bridge for App Intents in macOS 27 / iOS 27 is claimed only by a third-party blog (stork.ai). Apple confirms only App Intents and intent schemas for Siri, plus MCP in Xcode.
- Windows Build 2026 status of the third-party agent runtime/APIs, the 'Windows Agent Store', and on-device registry (ODR) GA: sources conflict. The Microsoft Learn agentic security page dates from Nov 2025 and describes an experimental preview.
- Claude Opus 4.8 system card figures (31.5% raw attack success rate, 0.5% with safeguards for Claude in Chrome/Cowork) come only from secondary coverage.
- Gemini 3.5 Flash computer use (preview, June 2026, self-reported OSWorld 78.4) and OpenAI GPT-5.4 desktop control (75% OSWorld) come from secondary blogs.
- Playwright MCP vs CLI token figures (114k vs 27k per task, ~4x) are from a single third-party benchmark. Exact current Playwright core version beyond 1.60 not confirmed.
- The OSWright probe (VS Code exposing 18 UIA elements vs 94 via OCR; 23x token reduction) is a vendor or practitioner claim.
- workflow-use self-healing (HealingService) maturity and the current OpenAdapt replay or runtime status were not confirmed against the upstream repos.
- The suggested promotion thresholds (≥10 runs, ≥25 runs over 14 days, 99% postcondition pass rate, 30–60 s outbox delay) are design recommendations, not sourced standards.
- AgentRewind and WebRollback are 2026 preprints seen only via search snippets.
- The exact OWASP Agentic Top 10 category names beyond ASI01 (goal hijack), ASI02 (tool misuse) and ASI10 (rogue agents) come from secondary summaries.
