# Research track: understanding-ml

# Research: turning activity streams into a work "twin" (as of 2026-10-30)

## TL;DR
- Read the **accessibility (AX) tree and OS events first**. Use pixels only as a fallback. Separate *context* (app, element role and label) from *data* (typed values). Mine patterns on context only and pull parameters out of data. This one split makes both anonymization and mining work.
- Keep three layers: **L0 raw** (kept for hours) → **L1 normalized events** (rolling 30–90 days, mappable to OCEL 2.0) → **L2 episodes and twin** (small, long-lived).
- On-device models do summarizing and labeling. Prefer the model the OS ships (Apple Foundation Models, Phi Silica) and fall back to open weights through llama.cpp. Cloud models (Claude) are opt-in and only ever see **abstracted, pseudonymized traces**, never screens or values.
- Licensing trap: **PM4Py is AGPL-3.0**, and so is OmniParser's detector. Ship the Rust4PM `process_mining` crate (MIT/Apache) in the product instead.

## 1. Event schema, sessionization, segmentation, labeling
**Schema**
- **OCEL 2.0** (RWTH, spec arXiv 2403.01975):
  - Events have an activity, a timestamp and attributes. Typed objects have attributes that can change over time.
  - Event-to-object (E2O) and object-to-object (O2O) relationships both carry qualifiers.
  - The SQLite format uses these tables: `event`, `event_map_type` (`ocel_type_map`), per-type `event_<T>`, `object`, `object_map_type`, `object_<T>` (`ocel_time`, `ocel_changed_field`), `event_object`, `object_object` (`ocel_qualifier`).
  - Use OCEL as the **export and interop format**, not as the hot-path store.
  - XES assumes one case per event. Flatten from OCEL per object type when a classic miner needs it.
- **Desktop object types:** App, Window, Artifact (document hash plus file extension; URL kept as domain plus path template), WebDomain, Person (pseudonym), UIElement (role plus normalized label), Project, Episode/Task, ClipboardItem (hash and type only).
- **Activities:** `app_focus`, `title_change`, `doc_open/save`, `url_visit`, `click(role,label)`, `edit(field, len, value_hash)`, `copy/paste(type, hash)`, `file_op`, `idle/lock`, `meeting_start`.
- **Leno's "normalized UI"** (ICPM 2020, arXiv 2008.05782) splits each UI action into *context parameters* (app, element label) and *data parameters* (values). Two runs of the same routine then produce the same token sequence.
- **Pragmatic baseline: ActivityWatch's model.** One bucket per watcher and host. Each event has `{timestamp, duration, data}`. Zero-duration heartbeats merge into the previous event when the data is identical and they fall inside `pulsetime`, which gives very large compression.

**Sessionization and segmentation (layered)**
1. **Hard cuts:** no input for more than about 5 minutes, screen lock, sleep, or a calendar meeting starting.
2. **Semantic drift:** a TextTiling-style drop in cosine similarity between embeddings of window titles and artifacts. A patent (US 20250053905) uses this idea for unsupervised desktop task segmentation.
3. **Structural (v2), Leno's method:**
   - Build a control-flow graph of normalized UIs and find strongly connected components (SCCs) and back-edges.
   - The target of a back-edge marks where a segment starts; its source marks where it ends.
   - Mine closed patterns with CloFast, rank them by frequency, length, coverage and **cohesion** (cohesion worked best), and remove noise.
   - Max runtime in their tests was 3.6 s. Code: `github.com/volodymyrLeno/RPM_Segmentator`.
   - Alternative: Agostinelli's interactive segmentation (trace alignment plus an end-delimiter action, SmartRPA).
4. **LLM refinement:**
   - cotomi Act (arXiv 2605.03231, May 2026) cuts segments on inactivity timeouts, then has an LLM write a structured record per segment (screen state, actions, changes, activity category).
   - In a blind review of 50 sessions by two annotators, an "agentic ETL" where the LLM decides the boundaries beat fixed rules. The result is qualitative only.
   - WONDERBREAD (NeurIPS 2024) reports that GPT-4 reaches an adjusted Rand index (ARI) of 0.88 on demo segmentation. Most errors were at the transitions between workflows.

**Labeling:** two levels.
- An **activity category** from a fixed taxonomy (communication, research, authoring, reporting, admin, coding, meeting).
- A **free-text task label**, clustered by embedding into stable task IDs.
- Generate both with JSON-schema-constrained output from the on-device model.

## 2. Pattern mining
- **Sequence mining** runs over context-only tokens, with each app's context kept as its own alphabet.
  - Python: `prefixspan` (chuanconggao) covers PrefixSpan, BIDE (closed patterns) and FEAT, with top-k and length limits. PAMI is a broader library.
  - SPMF (Java, GPL) has CloFast and SPADE.
  - Prefer closed or top-k mining with a minimum support of at least 3 instances, and rank by cohesion.
- **Process discovery:**
  - PM4Py 2.7.23.x has the inductive miner, DFGs, `read_ocel2_sqlite` and object-centric DFGs. It is AGPL, so use it only for offline research or internal analysis.
  - In the product: **Rust4PM `process_mining`** (0.5.x). It reads and writes OCEL 2.0 as JSON, XML and SQLite (plus an unofficial DuckDB format) and provides DFG and Alpha+++.
- **From routines to automation** (Leno et al., arXiv 2106.13446): segment → candidate routines → **automatability check** → executable specification → remove duplicates that do the same thing.
  - A routine is automatable only if every step can be replayed by a bot. Navigation, read, click and paste steps always can.
  - An *edit* step qualifies only when its value can be computed from earlier observed data. Leno tries **Foofah** (syntactic transformation) first and falls back to **TANE** (functional dependencies).
  - Frequency does not mean automatable: manual data entry repeats often but cannot be automated.
- **Variants and branches:**
  - Run a DFG or inductive miner over the instances of each routine and keep how often each variant occurs.
  - Use decision trees over context features at the points where routines branch.
  - Automate only variants with enough support. Hand control back to the user at any branch not seen before.
- **Parameter extraction:**
  - Align a routine's instances (multiple sequence alignment over tokens). Columns whose data values change are the parameters.
  - Classify each parameter as constant, derived, user-input or external.
  - For derived parameters, the modern approach has an LLM propose a transform as code, then checks it on held-out instances.
- **Data volume:** UiPath Task Mining suggests 2–7 users and 1–2 weeks of recording. For a single person, expect the first credible candidates after about 2 weeks.

## 3. Semantic understanding with models
**Inputs**
- Screenpipe reads the AX tree first and runs OCR only when it is empty. It says OCR is about 10–50× slower.
- Use a vision-language model (VLM) only for screens without accessibility data: canvas apps, remote desktops, poor Electron apps.

**On-device options (late 2026)**
- **Apple Foundation Models** (macOS 26+, M1+, Apple Intelligence turned on):
  - Use guided generation (`@Generable`).
  - `SystemLanguageModel.contextSize` reports the context window: Apple's docs say 4,096 tokens, and the WWDC26 sample shows 8,192.
  - Image attachments arrive with OS 27 (beta).
  - `PrivateCloudComputeLanguageModel`: 32K context, reasoning, "no prompts are ever stored", free for apps with fewer than 2M first-time downloads, entitlement required.
  - A new `LanguageModel` protocol lets an Anthropic Swift package back the same session.
- **Windows:**
  - Phi Silica through the Windows AI APIs `LanguageModel` (`GetReadyState` → `EnsureReadyAsync` → `CreateAsync`). Runs on Copilot+ PCs (40+ TOPS NPU, 16 GB). A GPU path needs an RTX 30-series or newer with 6 GB+. Not available in China.
  - Fallback: Foundry Local (ONNX Runtime with Windows ML execution providers; WebGPU on macOS).
- **Open weights:**
  - Qwen3.5 small (0.8B, 2B, 4B, 9B; natively multimodal; March 2026).
  - Qwen3-VL-2B/4B (Apache-2.0).
  - **Gemma 4 E2B/E4B** (April 2, 2026, **Apache 2.0**, vision and audio, about 128K context).
  - Phi-4-mini (3.8B). No Phi-5 is generally available.
- **Runtimes:**
  - llama.cpp: `libmtmd` provides multimodal input in `llama-server`, and the docs list Gemma 4.
  - MLX and MLX-VLM on Mac. ONNX Runtime GenAI. Ollama (convenient, but a separate daemon).
  - Linux NPUs are immature: AMD XDNA through FastFlowLM/Lemonade 10 (March 2026), Intel through OpenVINO. Treat the NPU as optional.
- **Screenshot cost:** Qwen3-VL works in 32-pixel units, so a 1920×1080 screenshot costs about 2,040 tokens. Cap images at 256–1,280 tokens with `max_pixels`.

**Escalating to Claude (opt-in)**
- **When:**
  - writing the procedure for a candidate the user has confirmed;
  - abstracting a workflow that spans several apps;
  - weekly consolidation of the twin;
  - segments the local model is unsure about.
- **What is sent:**
  - normalized tokens, app names and URL templates;
  - entities as salted-HMAC pseudonyms (`PERSON_17`, `DOC_a3`);
  - parameter *types*, never values.
- **Redaction:**
  - Use an allowlist schema: only fields from a fixed vocabulary are sent.
  - Run local named-entity detection (Presidio) as a second net. Presidio's own docs say it gives "no guarantee" of finding everything.
  - Show the user a preview of exactly what will be sent before anything leaves the device.
- **Models and pricing:**
  - `claude-sonnet-5-5` ($2/$10 per million tokens), `claude-opus-5-5` ($4/$20), `claude-haiku-5-5` ($0.10/$0.50).
  - Batches API for nightly jobs (50% off).
  - `inference_geo` for data residency.
- **Zero data retention:** Fable 5.x requires 30-day retention, so it is not zero-retention (ZDR) eligible. Pin escalation to models that are.
- **On a Mac:** Private Cloud Compute (PCC) is a middle tier between local and Claude.

**Embeddings and vector store**
- **Embedding models:**
  - EmbeddingGemma-300M: 768 dimensions, can be truncated to 128, under 200 MB quantized, 2K context.
  - Qwen3-Embedding-0.6B: 1,024 dimensions, 32K context, a few MTEB points higher.
- **Vector store:**
  - **sqlite-vec**: stable 0.1.9 (March 2026), still pre-v1. The `vec0` table supports float, int8 and bit vectors plus metadata and partition columns. Approximate-search files (DiskANN, IVF) exist in the repo, alongside 0.1.10 alpha releases.
  - Pair it with FTS5 in one SQLCipher-encrypted file.
  - Use **LanceDB** (Rust, IVF_PQ, hybrid full-text search) only past about 1M vectors.

## 4. Twin representation
- **Personal knowledge graph:** a property graph stored in SQLite as `nodes` and `edges` tables. OCEL O2O relationships map onto it directly.
  - Nodes: App, Artifact, Person (pseudonym), Project, Task, Procedure, Habit.
  - Edges: USES, TOUCHES, COLLABORATES_WITH, PART_OF, PRECEDES, TRIGGERED_BY.
- **Procedure library:** each procedure stores:
  - `intent` text and an embedding
  - preconditions (app and window state)
  - a typed `params` schema recording each parameter's source
  - steps, as normalized actions or higher-level API actions
  - variants with how often each was seen
  - success statistics
  - an `autonomy_level`
  - provenance (the instance IDs it was built from)

  Prior work:
  - Agent Workflow Memory (ICML 2025) builds workflows from text plus steps and lets them nest inside each other.
  - cotomi Act found scripts and insights stayed stable, while raw trajectories hurt at low coverage (about −2 percentage points at 17%). In one proxy test, adding 48 scripts raised success from 75.0% to 99.2%.
- **Preferences and habits:** key, value, confidence and last-seen, with exponential decay.
- **Temporal rhythms:** an hour-of-week grid (168 bins) by activity category, plus focus blocks, meeting load and app-switch rate.
- **Updating and staying small:**
  - Each night, cluster new episodes into procedures (embedding plus alignment), update counts with decay, and prune anything with low support.
  - The twin stays in the tens of MB, is versioned, and can be rebuilt from L1 while L1 is still retained.
- **Company mode:** the twin stays on the device and belongs to the employee. Only opt-in, k-anonymous procedure *templates* (no parameters) and counts with noise added leave the device. Hand this off to the privacy track.

## 5. Evaluation
- **Segmentation:** boundary F1 within ±30 s, ARI, Pk/WindowDiff.
- **Labeling:** macro-F1 on the activity category against labels the user confirmed, plus how stable task IDs stay.
- **Mining:**
  - candidate precision@k (the user agrees "this is a real repeated task");
  - coverage, Leno-style: the share of active time explained by discovered routines;
  - precision of the automatability check.
- **Procedures:**
  - step precision and recall against the SOP after the user edits it (WONDERBREAD: GPT-4 SOP F1 0.82, with hallucinated steps);
  - parameter accuracy;
  - success rate of dry-run replays.
- **Product:** acceptance rate, edit distance on accepted procedures, estimated time saved (frequency × duration), run success, intervention or undo rate, false-interrupt rate.
- **Privacy:** canary PII in outbound payloads must be 0.
- **Getting labels cheaply:**
  - Implicit signals: accept, dismiss and edit actions.
  - An end-of-day "your day in N tasks" review where the user confirms, merges or splits tasks. This also yields boundary labels.
  - At most 1–2 micro-prompts a day, shown at segment ends and chosen by active learning (the most uncertain segments).
  - Synthetic replays of known routines.
  - Public sets: WONDERBREAD (2,928 demos, 598 workflows), Leno's UI logs, WebArena/WorkArena.

## 6. Compute and storage budget (estimates)
- **Capture:** target under 2–3% CPU. For comparison, Screenpipe reports 3–5% on a static screen and 8–15% in active use when running OCR at 0.5–1 frames per second. Take snapshots only when an event triggers them, never continuous OCR.
- **LLM labeling:** about 40–80 segments a day × about 1.5K input and 200 output tokens ≈ 100K input tokens a day.
  - A 4B Q4 model is about 2.5 GB. Decode speed is roughly memory bandwidth ÷ model size, about 30–60 tok/s on M-series.
  - That works out to about 2–10 GPU-minutes a day on a Mac and about 15–40 minutes on a CPU-only x86 laptop.
  - Run it only when the machine is idle, on AC power and not thermally throttled. Load the model on demand and unload it afterwards.
- **VLM:** at most about 50 capped frames a day.
- **Storage:**
  - Merged events: about 5–20 MB a day. Adding deduplicated AX text: about 20–100 MB a day.
  - Screenshots would add 300 MB–2 GB a day (Screenpipe's figures), so do not keep them by default.
  - Vectors: 100K × 768 dimensions in int8 ≈ 77 MB, or about 25 MB at 256 dimensions.
  - Twin: under 50 MB.

## 7. Recommended pipeline
**MVP (single user; suggest-only, nothing runs automatically)**
1. **Capture (Rust, real time):** focus and title changes, URL template, AX focused element role and label, input *counts* only, clipboard type and hash, file events, idle and lock. Record ActivityWatch-style heartbeats.
2. **Normalize:** split context from data, apply HMAC pseudonyms, write L1 to SQLCipher.
3. **Segment (every 15 minutes):** hard cuts plus embedding drift.
4. **Label (hourly batch when idle):** use Apple FM, Phi Silica, or Gemma 4 E4B / Qwen3.5-4B through llama.cpp, producing JSON. Embed with EmbeddingGemma into sqlite-vec.
5. **Mine (nightly):** closed sequential patterns ranked by cohesion, a DFG via `process_mining`, and parameters found by alignment.
6. **Update the twin (nightly):** graph, procedures, rhythms.
7. **Surface (morning):**
   - Show the top 3 candidates with their evidence and estimated time saved.
   - Collect feedback.
   - Offer opt-in Claude Sonnet 5.5 synthesis through Batches, with a preview of what will be sent.

**v2**
- Leno-style CFG back-edge segmentation plus LLM refinement of boundaries; OCEL 2.0 export and object-centric DFGs.
- Automatability checks plus synthesis of transforms verified on held-out instances.
- A VLM fallback for screens without accessibility data.
- Autonomy levels raised one step at a time:
  - observe → suggest → assist → autonomous with confirmation → autonomous;
  - a procedure moves up only after N clean supervised runs;
  - each procedure has its own kill switch.
- Per-user LoRA adapters for the labeler (Apple FM adapters / MLX).
- Company-mode federated templates.
- A continuous evaluation harness.

## Sources
[OCEL 2.0 spec](https://arxiv.org/pdf/2403.01975) · [ocel-standard.org](https://www.ocel-standard.org/) · [Leno ICPM'20](https://arxiv.org/abs/2008.05782) · [Leno executable routines](https://arxiv.org/abs/2106.13446) · [cotomi Act](https://arxiv.org/html/2605.03231) · [WONDERBREAD](https://arxiv.org/abs/2406.13264) · [Agent Workflow Memory](https://arxiv.org/abs/2409.07429) · [Agostinelli SmartRPA](https://iris.uniroma1.it/retrieve/4029318e-f99e-4297-bea4-799844bc8776/Agostinelli_Intelligent_2022.pdf) · [PM4Py versions](https://www.piwheels.org/project/pm4py/) · [Rust4PM process_mining](https://docs.rs/crate/process_mining/0.5.3/source/README.md) · [prefixspan-py](https://github.com/chuanconggao/PrefixSpan-py) · [WWDC26 Foundation Models](https://developer.apple.com/videos/play/wwdc2026/241/) · [Apple TN3193 context](https://developer.apple.com/tutorials/data/documentation/technotes/tn3193-managing-the-on-device-foundation-model-s-context-window.md) · [Phi Silica](https://learn.microsoft.com/en-us/Windows/ai/apis/phi-silica) · [Foundry Local arch](https://learn.microsoft.com/en-ca/Azure/foundry-local/concepts/foundry-local-architecture) · [llama.cpp multimodal](https://github.com/ggml-org/llama.cpp/blob/master/docs/multimodal.md) · [Gemma 4 Apache 2.0](https://the-decoder.com/googles-gemma-4-is-now-available-with-apache-2-0-licensing-for-the-first-time/) · [Qwen3.5 small](https://qudata.com/en/news/exploring-qwen35-family/) · [Qwen3-VL pixel control](https://mintlify.wiki/QwenLM/Qwen3-VL/inference/pixel-control) · [EmbeddingGemma](https://arxiv.org/html/2509.20354v3) · [sqlite-vec](https://github.com/asg017/sqlite-vec) · [LanceDB embedded](https://www.lancedb.com/lp/embedded-oss) · [Screenpipe architecture](https://docs.screenpi.pe/architecture) · [ActivityWatch data model](https://docs.activitywatch.net/en/latest/buckets-and-events.html) · [Presidio](https://microsoft.github.io/presidio) · [OmniParser V2](https://labs.ai.azure.com/innovations/omniparserv2/) · [UiPath Task Mining FAQ](https://docs.uipath.com/task-mining/automation-suite/2023.10/user-guide/faq) · [AMD NPU on Linux](https://www.phoronix.com/news/AMD-Ryzen-AI-NPUs-Linux-LLMs) · [Recall requirements](https://learn.microsoft.com/windows/client-management/manage-recall)


## Key decisions
- **What the observation layer reads first** → Read the accessibility (AX) tree and OS events first. Take screenshots only when an event triggers them, run OCR or a vision-language model only on screens with no accessibility data, and keep no screenshots by default. — _Screenpipe reports OCR is 10-50x slower than reading the AX tree, and screenshots cost 300 MB-2 GB a day. Screenshots are also the biggest privacy risk._
- **Canonical event store format** → Store events in our own SQLite (SQLCipher) schema that maps one-to-one onto OCEL 2.0 objects, events and qualified relationships. Use OCEL 2.0 SQLite or JSON as the export and interop format, and flatten to XES only when a classic tool needs it. — _OCEL fits desktop work, where several objects (app, document, person, URL) are involved at once and their attributes change over time. Its relational layout, with one table per type, is awkward for fast real-time writes._
- **Process-mining library in the shipped product** → Ship the Rust4PM `process_mining` crate (MIT/Apache; OCEL 2.0, DFG, Alpha+++) and `prefixspan`/BIDE-style mining. Keep PM4Py, SPMF and the OmniParser detector to offline research only. — _PM4Py and the OmniParser detector are AGPL-3.0 and SPMF is GPL, which creates copyleft risk for a commercial desktop binary._
- **Separating context from data** → Normalize every UI event into context (app, element role and label, field name) and data (values). Pseudonymize data with a per-device salted HMAC. Mine patterns on context only and extract parameters from aligned data. — _This is Leno's normalized UI log. One split serves anonymization, pattern mining and parameter extraction at the same time._
- **On-device LLM strategy** → Use the model the OS ships first: Apple Foundation Models on macOS and Phi Silica on Copilot+ PCs. Otherwise fall back to Gemma 4 E4B or Qwen3.5-4B (Q4) through embedded llama.cpp. Load the model on demand in idle batches and use JSON-schema-constrained output. — _OS models need no download and share memory. Open weights under Apache-2.0 cover Linux and older hardware. Small context windows (4K-8K on Apple) mean chunking per segment._
- **Cloud escalation policy** → Make escalation opt-in and send only allowlisted abstract traces: tokens, URL templates, pseudonyms and parameter types, never values or screens. Show a preview before sending. Use ZDR-eligible Claude models (Sonnet 5.5 / Opus 5.5) through the Batches API for nightly synthesis, not Fable 5.x, which requires 30-day retention. On Mac, use Private Cloud Compute as a middle tier. — _Redaction tools like Presidio give no guarantee of finding everything, so an allowlist is the main control. Batches cut cost by 50%._
- **Vector store** → sqlite-vec (pin the version) plus FTS5 in the same encrypted SQLite file, with EmbeddingGemma-300M truncated to 256 dimensions in int8. Revisit LanceDB only past about 1M vectors. — _One encrypted file holds everything, and footprint and dependencies stay minimal. About 100K vectors take about 25 MB._
- **Task segmentation approach** → MVP: hard cuts (idle, lock, meetings) plus embedding drift. v2: add Leno's CFG back-edge segmentation and LLM refinement of boundaries, evaluated on boundary F1 and ARI. — _The heuristics are cheap and robust. Leno's method handles repeated routines, and in cotomi Act's review LLM-chosen boundaries were judged better than fixed rules._
- **Autonomy model for 'make it work itself'** → Raise autonomy one level at a time per procedure: observe, suggest, assist, autonomous with confirmation, autonomous. A procedure moves up only after N clean supervised runs with no corrections, and each procedure has a kill switch. The MVP is suggest-only. — _Small models invent steps (WONDERBREAD), and real traces are noisy. Frequency does not mean a task can be automated (Leno)._
- **Data retention tiers** → Keep L0 raw signals for hours, L1 normalized events for a rolling 30-90 days, and L2 episodes for about a year. The twin (graph, procedures, rhythms) is versioned, can be rebuilt from L1, and stays under about 50 MB. — _This keeps storage and breach exposure bounded while still allowing the twin to be recomputed._

## Risks
- AGPL/GPL contamination if PM4Py, the OmniParser detector or SPMF get bundled into the shipped app.
- PII detection never catches everything (Presidio states no guarantee), so cloud escalation can leak data. Mitigate with an allowlist schema, canary tests and a preview before sending.
- Pseudonymized data is still personal data under GDPR. In company mode, monitoring work behaviour may fall under employment law and high-risk AI regimes (e.g. EU AI Act Annex III on worker monitoring), and works-council or DPIA obligations may apply. Hand this to the legal/privacy track.
- On-device model availability is fragmented: Apple Intelligence may be turned off or the Mac older than M1; Phi Silica needs a Copilot+ PC or an RTX GPU and is not available in China; Linux has no OS model and immature NPU support. That means a big test matrix and inconsistent quality.
- Battery, thermal and RAM load from a 2.5-3 GB local model on 8-16 GB laptops could drive uninstalls. Run inference only when idle and on AC power.
- Segmentation fails on heavily interleaved multitasking (WONDERBREAD errors cluster at transitions). Real traces carry detours and failures that published results did not test (a cotomi Act limitation).
- Knowledge work may have few truly repeated routines. Frequent is not the same as automatable when the data is entered by hand, so the number of candidates may disappoint.
- Small LLMs invent steps and labels, and this compounds into wrong procedures when autonomy is raised too early.
- Accessibility permission friction (macOS Accessibility and Screen Recording prompts), plus Electron and canvas apps that expose poor AX trees.
- Pre-v1 dependencies (sqlite-vec, Foundry Local SDKs, Rust4PM 0.x) may ship breaking changes. Pin versions.
- Apple's on-device context of 4K-8K tokens forces aggressive chunking, and long episodes lose context.

## Unverified
- Apple on-device model context size of 8,192: it appears only as a code comment in the WWDC26 session (241), while Apple's TN3193 docs say 4,096. Image input on the on-device model is OS 27 beta; the macOS minimum was not confirmed.
- Private Cloud Compute 'free for <2M first-time downloads' and 'no prompts stored' come from the WWDC26 session page. The entitlement terms were not reviewed.
- Qwen3.5 small series specs (262K context, native multimodality, March 2026) come only from secondary sources, not the official model card.
- Gemma 4 E2B/E4B 128K context and parameter counts come from secondary sources. The Apache 2.0 license is confirmed by several outlets, but the Google blog was not opened.
- Exact latest PM4Py version (2.7.23.3 vs 2.7.23.8) and the exact name of the object-centric DFG discovery function.
- Whether sqlite-vec's approximate-search indexes (DiskANN/IVF) are usable in the 0.1.10 alphas; only their source files were seen in the repo.
- Foundry Local release status (some sources say GA, Microsoft's FAQ says alpha/pre-release) and the Phi Silica GPU path, whose docs conflict.
- Official llama.cpp support for Qwen3-VL. Only third-party evidence was found; Gemma 4 is listed officially.
- All laptop throughput and compute-minute figures are my estimates from the bandwidth rule of thumb, not measured. Validate with llama-bench on the target hardware.
- Screenpipe CPU and storage figures are vendor-reported and inconsistent with each other.
- cotomi Act's finding that LLM segmentation beats rule-based segmentation is qualitative, with no numbers. The ETL model was not named.
- ZDR eligibility for Claude Opus 5.5 and Sonnet 5.5 is inferred: docs say treat Opus 5.5 like Opus 5, and Fable 5.x is excluded. Haiku 5.5 ZDR status was not checked. Confirm with Anthropic for the org.
- The Anthropic Swift package for the Foundation Models LanguageModel protocol is mentioned at WWDC26 but was not inspected.
- Linux NPU LLM support (FastFlowLM/Lemonade 10, Intel OpenVINO on Linux) is based on news-level reporting.
- Embedding model MTEB comparison numbers (Qwen3-Embedding-0.6B vs EmbeddingGemma) come from a secondary aggregator.
