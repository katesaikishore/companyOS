# Research track: prior-art

## Prior art and competitive landscape: observe, understand, automate (as of 2026-10-30)

### Bottom line
- The idea is now mainstream, and the platform owners are moving in. Microsoft Recall shipped GA on Copilot+ PCs in about April 2025. Anthropic launched Claude Cowork "Record a skill" on 2026-07-21: you record your screen and narrate, and it produces a reusable skill. Google's Mariner "Teach & Repeat" was folded into Gemini Agent when Mariner shut down on 2026-05-04. Enterprise "watch employees" vendors are raising large rounds (Skan AI $63M Series C, Aug 2026).
- Unclaimed ground: nobody combines (1) cross-platform passive capture, (2) a twin owned by the employee with real anonymity toward the employer, and (3) compiled, verifiable automations rather than live LLM clicking. Personal tools have no enterprise trust model. Enterprise tools are built for the employer, not the employee.
- The big failures were all about trust: Recall's 2024 plaintext database, Meta's 2026 keystroke-tracking revolt, and Screenpipe's 2026 license switch. Ship privacy as architecture, not as settings.

### 1. Personal "screen memory" products
**Microsoft Recall (Windows 11, Copilot+ PCs only)**
- **Captures:** a screenshot every few seconds, then local OCR and semantic indexing. Needs an NPU, at least 16 GB RAM and device encryption.
- **2024 backlash:** the preview kept snapshots and an SQLite index in plaintext under the user profile. It was pulled before launch.
- **Redesign:**
  - off by default (opt-in), and removable;
  - snapshots, OCR and the vector DB are processed inside a VBS Enclave;
  - keys are TPM-bound and released only through Windows Hello Enhanced Sign-in Security, and the authorization times out;
  - concurrency and monotonic-counter protections; per-app and per-site exclusions.
- **Enterprise controls:** the policy CSP `WindowsAI/AllowRecallEnablement` (default 1; 24H2 KB5055627+) and `AllowRecallExport` (Insider, Enterprise/Edu only). Recall is disabled by default on managed PCs.
- **Still criticized:**
  - The Register (Aug 2025) and Tom's Hardware found the "Filter sensitive information" setting still captured credit cards and passwords. Microsoft concedes it is "not perfect".
  - Signal turned on DRM-style "Screen security" by default to black out Recall. Brave and AdGuard also block it.
  - Lesson: apps will opt out of your capture, and keyword filters fail.

**Screenpipe (Mediar / Negentropy Labs, YC S26)**
- **Captures:** event-driven screenshots (on app switch, click, typing pause) paired with the accessibility tree. OCR is only a fallback (Apple Vision, Windows OCR, Tesseract). Also audio via Whisper or Deepgram, keyboard input and app switches.
- **Storage and access:** SQLite plus mp4 files, a local REST API on :3030, and MCP.
- **Privacy:**
  - local by default;
  - local PII-redaction model (MLX / DirectML);
  - app, window and URL filters; incognito exclusion; schedules;
  - token-protected API with time and modality scopes;
  - encryption at rest only "early".
- **Pricing:** Free; Basic $21/mo; Business $42/seat/mo; Enterprise custom (shared team context, SSO, MDM, "turn company work into agents").
- **License changed 2026-06-09** from MIT to the "Screenpipe Commercial License" (source-available, not OSI):
  - free for personal, non-commercial, educational and research use, with a 7-day evaluation;
  - any commercial or production use, including builds from source, needs a paid Enterprise license, whatever the company size;
  - 5 or more users at one company need Team or Enterprise;
  - versions released before the change stay MIT.
- **Criticism on HN:** the license bait-and-switch, CPU heat on an M1, a reported API-key leak through an automation, GitHub stargazer emails added to a marketing list, and doubt that EU employers can deploy it at all.

**Rewind / Limitless**
- Rewind was a Mac-only local screen and audio memory. The company rebranded as Limitless and pivoted to a pendant.
- Meta acquired it on 2025-12-05. Rewind and Limitless recording was disabled on 2025-12-19 and pendant sales stopped. Export and delete tools were promised.
- Lesson: users' memory dies with the vendor. Data portability and a local-first design that survives the company are selling points.

**OSS clones:** OpenRecall (AGPL-3.0), Windrecorder (GPL-2.0), rem (MIT, macOS), Dayflow (MIT, macOS timeline with AI summaries), Daydream (snackbit; license unverified).

### 2. Enterprise task and process mining (employer-centric)
**UiPath Task Mining**
- A desktop client captures clicks, keys, apps and screenshots. ML clusters the data into candidate tasks, which feed Studio and Automation Hub.
- Older docs: PII is masked during processing and original screenshots are not stored.
- "Unassisted" Task Mining was removed on 2025-12-01. Task Mining was deprecated in the Public Sector cloud from 2026-09-01. It is being folded into Process Mining and priced via Unified Pricing (quote only).

**Celonis Task Mining**
- Redaction runs client-side at capture: Windows username, machine name, emails, SSNs and card numbers.
- Optional user-name hashing (the docs conflict on the default). Screenshots are off by default.
- Consent screen; the user can pause and see what was captured; URL allow and deny lists. Docs are behind a login.

**Microsoft Power Automate Process Mining** (formerly Process Advisor)
- The PAD desktop recorder captures user-initiated recordings with screenshots. Users must pause or delete steps to remove PII manually.
- Dataverse role-based access. Windows only, no ARM. Bundled with the per-user license.

**Skan AI**
- A desktop agent observes work across apps and builds a "context graph". Data stays behind the firewall, and only anonymized metadata goes to the cloud; a private appliance is an option.
- Opt-in app/URL scoping. Results are aggregated across many workers ("the process, not the person"). Works-council approvals in the EU.
- Now sells agents that act on the graph; about 60% of AML cases at one customer are run by agents.
- Press frames it as "process intelligence or workplace surveillance?" and notes customers cutting headcount.

**Soroco Scout**
- Agent plus browser extension. Builds a "work graph" from anonymized user IDs; claims it never singles out individuals; app allowlists.
- Little public technical documentation.

**Pattern:** the employer sees processes, and employees are reduced to pseudonymous IDs. That is pseudonymization, not anonymization under GDPR, and the employee gets no value back.

### 3. From demonstration to automation
**OpenAdapt (MIT, verified)**
- Now a pipeline: record → compile → qualify → admit → run → repair.
- Each step targets the most reliable layer available: DOM, UIA, AX or AT-SPI first, then an observed API call, and pixels only as a last resort.
- Runs need no model calls. Each run verifies the record before saving and reads it back afterwards.
- On UI drift it halts. An agent proposes a patch and a human approves it.
- `openadapt flow induce` merges several demonstrations into a program with branches and loops.
- The `openadapt-privacy` package uses Presidio and OCR redaction on text, element trees and screenshots. It fails closed when `OPENADAPT_FLOW_SCRUB=on`.
- OpenAdapt Cloud is the commercial fleet control plane.
- This is the best architectural template for running automations safely without supervision.

**Claude Cowork "Record a skill"**
- Records screen, clicks, typing and voice narration, and produces a reusable skill.
- Pro, Max and Team plans. It is on-demand, not passive.
- Cowork computer use runs on macOS (from Jan/Mar 2026) and Windows (Apr 2026). Dispatch hands tasks from phone to desktop.

**Google:** Mariner (Teach & Repeat, May 2025) shut down on 2026-05-04 and was folded into Gemini Agent and Chrome auto-browse.

### 4. General computer-use agents (the execution layer)
**OpenAI**
- Operator became ChatGPT agent mode.
- The Atlas browser was reportedly folded into the ChatGPT desktop app and Codex (announced 2026-07-09, shutdown target 2026-08-09).
- OpenAI states prompt injection is "unlikely to ever be fully solved". Atlas was exploited through hidden Google Docs text and the omnibox.

**Microsoft Copilot Actions on Windows** (experimental) has the best published OS security model:
- off by default (Settings > System > AI components > Agent tools > Experimental agentic features);
- a separate **agent account** and an isolated **agent workspace** (its own desktop);
- access limited to known folders unless granted;
- agents must be signed;
- the user can watch and take over, and must approve sensitive steps;
- explicitly names the cross-prompt injection (XPIA) threat.

Copilot Vision is share-to-see, opt-in per session.

**Apple:** the WWDC 2026 Siri combines onscreen awareness, personal context and App Intents, processed on-device or in Private Cloud Compute. Third-party App Intents coverage is reportedly limited. This is a likely future competitor on macOS and iOS.

### 5. "Digital twin of the employee" startups
- **Viven** (Oct 2025, $35M seed, Khosla, Eightfold founders) builds a per-employee LLM from email, Slack and Docs so coworkers can query it when the person is away.
- **Twin1 AI** (Aug 2026, $20M seed, Bessemer) builds a per-professional twin from email, meetings and docs. It works inside Slack, Teams, Outlook and Gmail, and the user controls the sources and who can query the twin. It claims to automate 30–50% of communications work (self-reported) and has legal customers such as Linklaters and Orrick.
- Both build twins of knowledge and communications, not of desktop behavior. Neither does passive desktop observation or UI automation, so that is whitespace.

### 6. Monitoring and bossware (what to avoid)
- **ActivTrak and Insightful:** app and URL tracking, screenshots, stealth mode (Insightful), and productive/unproductive scores. The common complaint is that employees see them as intrusive.
- **Meta "Model Capability Initiative"** (Apr–Jun 2026): it logged US employees' mouse movements and keystrokes to train agents. Over 1,500 staff signed a petition, it was called an "Employee Data Extraction Factory", and Meta scaled it back on 2026-06-02 to a 30-minute pause plus exemptions.
  - Lesson: "the data trains the AI that replaces me" is the core fear. Value has to go to the employee first.
- **Regulators:**
  - CNIL fined Amazon France Logistique €32M (Dec 2023) for idle-time and latency indicators.
  - EU AI Act Annex III treats worker monitoring, task allocation and performance evaluation as **high-risk**. The Digital Omnibus deferred stand-alone high-risk obligations from 2026-08-02 to **2027-12-02**; the duties are delayed, not removed. Article 26(7) requires informing workers' representatives.

### Lessons learned
1. **Encryption at rest is table stakes.** Plaintext local databases are what killed Recall v1. Gate decryption behind OS biometrics, a TPM or Secure Enclave key, and a timeout.
2. **Capture structure, not pixels.** Use accessibility trees and app/window events by default (Screenpipe, OpenAdapt). Make screenshots opt-in and short-lived, kept only until they are converted to structure.
3. **Keyword PII filters fail.** Layer them: app/URL denylists, plus honoring `WDA_EXCLUDEFROMCAPTURE`/DRM flags, private browsing and password fields, plus ML redaction, failing closed.
4. **Opt-in, a visible indicator, pause, review and delete** are expected minimums (Celonis, Recall, Meta's forced concession).
5. **Aggregation alone does not create trust.** Skan and Soroco still get called surveillance. Value has to go to the employee first.
6. **Never pivot the license after building a community** (Screenpipe). Pick the license on day 1.
7. **Vendor death destroys memory** (Rewind). Use open, exportable formats.
8. **Autonomous execution needs isolation, identity and approval** (Copilot Actions model) and deterministic replay with verification (OpenAdapt). Assume prompt injection cannot be solved.

### Whitespace this product can own
- **A twin owned by the employee with a provable one-way valve to the employer.** Raw data never leaves the device. The company gets only differentially private, k-anonymous process aggregates, released only after the employee previews them. Nobody ships this.
- **Truly cross-platform** (Win/macOS/Linux) passive capture plus automation. Recall is Windows-only, Rewind was Mac-only, Celonis and PAD are Windows-centric, and Linux is underserved.
- **Passive discovery that proposes automations.** Notice repetition, then suggest a skill, compiled into a deterministic and verified program. Claude "Record a skill" and Teach & Repeat require explicit demonstrations.
- **Model-agnostic execution:** export automations as MCP tools or Claude/agent skills instead of competing on the agent itself.
- **Designed for compliance from the start:** no individual scoring, DPIA and works-council kit, ready for EU AI Act December 2027.

### Reusable OSS (license verified from LICENSE files on main/master unless noted)
| Component | Use | License |
|---|---|---|
| OpenAdapt | record→compile→replay architecture | **MIT** |
| openadapt-privacy | PII scrubbing for GUI data | MIT? (unverified) |
| Microsoft Presidio | PII detection | **MIT** |
| Screenpipe ≥ 2026-06-09 | capture engine | **Screenpipe Commercial License (not usable commercially without a deal)**; older tags MIT (last MIT tag unverified) |
| mediar-ai/terminator | Rust/TS/Py accessibility automation SDK (Windows-first; macOS/Linux experimental) | **MIT** |
| ActivityWatch | cross-platform window/AFK watchers, local server | **MPL-2.0** (file-level copyleft; OK to link) |
| microsoft/UFO (UFO2) | Windows UIA agent | **MIT** |
| UI-TARS-desktop (ByteDance) | GUI agent app | **Apache-2.0** |
| Simular Agent-S | GUI agent framework | **Apache-2.0** |
| xcap (Rust) | cross-platform screen capture | **Apache-2.0** |
| rdev (Rust) | global input events | **MIT** |
| whisper.cpp | local speech-to-text | **MIT** |
| rem / Dayflow | macOS screen memory / timeline | **MIT** |
| OmniParser | screen parsing | repo LICENSE **CC-BY-4.0**; icon_detect weights **AGPL** (README) |
| OpenRecall | screen memory | **AGPL-3.0**, avoid in a closed client |
| browser-use/workflow-use | record→replay for browser | **AGPL-3.0**, avoid or isolate |
| Windrecorder | screen memory | **GPL-2.0**, avoid |

### Sources (primary where possible)
- [Screenpipe LICENSE.md](https://raw.githubusercontent.com/mediar-ai/screenpipe/main/LICENSE.md)
- [Screenpipe license update](https://screenpipe.com/blog/screenpipe-license-update)
- [Screenpipe pricing](https://screenpipe.com/pricing)
- [Launch HN: Screenpipe](https://news.ycombinator.com/item?id=49024620)
- [OpenAdapt](https://github.com/OpenAdaptAI/OpenAdapt)
- [openadapt-privacy](https://pypi.org/project/openadapt-privacy/)
- [Windows agentic security](https://learn.microsoft.com/en-us/windows/security/book/operating-system-agentic-security)
- [Policy CSP WindowsAI](https://learn.microsoft.com/windows/client-management/mdm/policy-csp-windowsai)
- [The Register on Recall's filter](https://www.theregister.com/2025/08/01/microsoft_recall_captures_credit_card_info/)
- [9to5Mac on Rewind/Limitless](https://9to5mac.com/2025/12/05/rewind-limitless-meta-acquisition/)
- [UiPath Task Mining release notes](https://docs.uipath.com/task-mining/automation-cloud/latest/release-notes/public-sector-august-2026)
- [Celonis project setup](https://docs.celonis.com/en/setting-up-a-task-mining-project.html)
- [Power Automate process mining security](https://learn.microsoft.com/en-us/power-automate/process-advisor-security)
- [VentureBeat on Skan](https://venturebeat.com/data/skan-ai-raises-63-million-betting-that-watching-how-employees-actually-work-is-the-missing-layer-of-enterprise-ai)
- [The Decoder on Cowork Record a skill](https://the-decoder.com/claude-cowork-learns-new-skills-through-screen-recordings-and-voice-over-explanations/)
- [Android Authority on Mariner shutdown](https://androidauthority.com/google-project-mariner-shutdown-3664323/)
- [TechCrunch on Viven](https://techcrunch.com/2025/10/15/eightfold-co-founders-raise-35m-for-viven-an-ai-digital-twin-startup-for-querying-unavailable-coworkers)
- [SiliconANGLE on Twin1](https://siliconangle.com/2026/08/20/twin1-ai-raises-20m-to-put-an-ai-twin-behind-every-knowledge-worker/)
- [RTE on Meta tracking](https://www.rte.ie/news/business/2026/0603/1576504-meta-scales-back-plan-for-internal-mouse-tracking-tech/)
- [CNIL Amazon fine](https://cnil.fr/en/employee-monitoring-cnil-fined-amazon-france-logistique-eu32-million)
- [DLA Piper on the AI Omnibus](https://knowledge.dlapiper.com/dlapiperknowledge/globalemploymentlatestdevelopments/2026/The-Digital-AI-Omnibus-Proposed-deferral-of-high-risk-AI-obligations-under-the-AI-Act)
- [Fortune on Atlas prompt injection](https://fortune.com/2025/12/23/openai-ai-browser-prompt-injections-cybersecurity-hackers/)

## Key decisions
- **Base capture engine: fork Screenpipe vs build own** → Build our own capture layer from permissively licensed parts: xcap (Apache-2.0), rdev (MIT), terminator/OS accessibility APIs (MIT), ActivityWatch watchers as reference (MPL-2.0), whisper.cpp (MIT). Treat Screenpipe only as design reference. If anything is forked, use only a pre-2026-06-09 MIT tag, after verifying it. — _Since 2026-06-09, Screenpipe requires a paid commercial license for any commercial use, including builds from source. A product that competes with it cannot rely on that._
- **Primary signal: accessibility tree and events vs screenshots and OCR** → Default to structured signals: UIA, AXUIElement, AT-SPI, app/window/URL events and input cadence. Screenshots are opt-in, short-lived and redacted before they are persisted; OCR is the fallback only. — _Smaller privacy surface and lower CPU. Recall's screenshot store was the core of its backlash and its PII filter still leaks. Screenpipe and OpenAdapt both moved to accessibility-first._
- **Anonymity model for company mode** → The employee owns the twin, and raw data never leaves the device. The employer receives only k-anonymous, differentially private process aggregates (minimum cohort size), after the employee previews them. No per-person scores, rankings or idle-time metrics, ever. — _Pseudonymous IDs (Soroco, Celonis hashing) are not anonymization under GDPR. Per-person monitoring is EU AI Act Annex III high-risk (applies from 2027-12-02) and has drawn CNIL fines. Meta's 2026 revolt shows employees reject extraction framing._
- **How automations execute ('make it work itself')** → Compile observed workflows into deterministic, versioned programs that target the accessibility/DOM/API layers (OpenAdapt's record→compile→qualify→admit→run model). Use LLMs for discovery and proposing repairs, not for every step. Run under a separate least-privilege agent identity, with approval gates for sensitive actions and verification after each write. — _Prompt injection is acknowledged as unsolvable by OpenAI and Microsoft (XPIA). Deterministic replay is auditable, cheap and safe to run unattended. Copilot Actions' agent account and workspace design is the reference OS model._
- **Positioning vs platform agents (Claude Cowork Record a skill, Copilot Actions, Gemini Agent, Apple Siri)** → Do not compete on the general computer-use agent. Differentiate on passive discovery across Windows, macOS and Linux, plus an employee-owned twin. Export automations as MCP tools or agent skills that any agent can run. — _Platform vendors already ship explicit record-a-demo and agentic execution. Passive, cross-platform, privacy-provable discovery with enterprise aggregates is unclaimed._
- **License strategy for our own code** → Decide on day 1: either an MIT/Apache client core with a commercial cloud/control plane (OpenAdapt model), or a closed client. Avoid AGPL/GPL dependencies in the client (OpenRecall, workflow-use, Windrecorder, OmniParser icon_detect weights). — _Screenpipe's MIT-to-commercial pivot caused community backlash. AGPL/GPL contamination would force open-sourcing the client._
- **Data durability and portability** → Use open local formats (SQLite plus documented schema), one-click export and delete, and keep the app working offline without our cloud. — _Rewind's recording was disabled within two weeks of Meta's acquisition, and users lost their memory product. Portability is a trust differentiator._

## Risks
- Platform commoditization: Microsoft (Recall + Copilot Actions + agent workspace), Anthropic (Cowork Record a skill + computer use on macOS/Windows), Google (Gemini Agent / Chrome auto-browse) and Apple (Siri onscreen awareness + personal context) are bundling observe and act into the OS or assistant.
- A single security incident (e.g., an unencrypted local store like Recall v1, or a local API exfiltration like the one reported against Screenpipe) could permanently destroy trust in a product whose premise is watching everything.
- Employee backlash in company mode (Meta MCI 2026: 1,500+ petition signers, 'Employee Data Extraction Factory') if it is perceived as training AI to replace workers or as bossware.
- Regulatory: EU AI Act high-risk obligations for worker monitoring and task allocation apply from 2027-12-02 (delayed, not removed). GDPR/CNIL precedent (Amazon €32M). Works-council co-determination in DE/FR/NL. Pseudonymized data is still personal data.
- Re-identification: behavioral sequences (app usage, timing, typing cadence) are highly identifying even when hashed. Small teams make aggregates de-anonymizable without k-thresholds and differential-privacy noise.
- PII filters are unreliable (Recall still captured cards and passwords in Aug 2025 tests). Plan defense in depth and fail closed.
- Capture blind spots: apps increasingly set capture-exclusion or DRM flags (Signal, Brave), and OS permission prompts (macOS Screen Recording/Accessibility, Wayland portals) reduce coverage and onboarding conversion.
- Prompt injection during autonomous runs: content on screen or in documents can hijack an LLM-driven executor. Vendors concede it cannot be fully solved.
- Resource usage (CPU, heat, battery, disk) from continuous capture: a recurring Screenpipe complaint.
- Dependency and license drift: OSS projects can relicense (Screenpipe did). AGPL components (OpenRecall, workflow-use, OmniParser icon_detect weights) would contaminate a closed client.
- Acquisition or shutdown risk for any third-party component or partner (Rewind/Limitless, Mariner, Atlas all discontinued within 12 months).

## Unverified
- Microsoft Recall GA date (reported April 2025 on Copilot+ PCs) and any 2026-specific Recall changes; the exact function of the AllowRecallExport policy.
- Exact last MIT-licensed Screenpipe release tag before the 2026-06-09 license change; current canonical repo path (mediar-ai/screenpipe vs screenpipe/screenpipe); whether an ee/ directory with separate terms still exists.
- openadapt-privacy package license (assumed MIT, not checked); OpenAdapt Cloud pricing.
- OpenAI Atlas shutdown (announced 2026-07-09, target 2026-08-09) and the 'ChatGPT Work agent' name: secondary sources only.
- Claude computer-use launch dates (macOS Jan vs Mar 2026; Windows ~2026-04-03) and plan eligibility (sources conflict on Pro/Max-only vs Team/Enterprise); where 'Record a skill' recordings are processed and retained, and the output format.
- Whether Mariner's Teach & Repeat is available in Gemini Agent today.
- Copilot Actions on Windows general-availability status in 2026 (only preview-era docs found); Copilot Vision 'standard feature' claim (single source, May 2026).
- Apple WWDC 2026 Siri details and how much runs on-device vs in Private Cloud Compute (search results conflicted on shipping completeness).
- Celonis default for user-name hashing (docs conflict); Celonis privacy docs are login-gated.
- Soroco Scout technical and privacy details: mostly third-party or marketing sources.
- UiPath Task Mining status for the commercial (non-public-sector) Automation Cloud beyond 2026; pricing is quote-only.
- Power Automate desktop recorder / process mining 2026 roadmap or deprecation status: no 2026 source found.
- Daydream (snackbit/daydream) license and status.
- Regulation (EU) 2026/1744 (Digital Omnibus on AI) Official Journal publication date (one source says 2026-07-24).
- A reported CNIL €40k fine for screenshot-based teleworker monitoring could not be confirmed and is excluded from the report.
- Twin1 AI's '30-50% of communications automated' and customer names are company-reported.
