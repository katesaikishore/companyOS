# Research track: privacy-legal

## Privacy and regulation for a workplace digital twin: research input (as of 30 Oct 2026)

### 0. Bottom line
- **A twin of one person is never anonymous to that person or their device.** It is a profile of an identifiable person, which is profiling under GDPR Art. 4(4). "Anonymous" can only honestly describe what **other parties** receive: the vendor and the employer.
- The design that holds up in court: raw capture and the twin stay on the device under a key the user holds. The employer receives only **k-thresholded, differentially private aggregates about processes, never about people**, plus automations that an employee chooses to share. There is **no individual scoring**, and the product has no API that could provide it.
- **Company mode is still regulated even if no data leaves the device.** An employer that rolls the app out decides why and how it is used, so it is likely a (joint) controller. CJEU *Wirtschaftsakademie* C‑210/16 held that joint controllership does not require access to the data. The employer therefore still needs a DPIA, a lawful basis, works-council approval and notices. The product should ship a compliance kit.

### 1. EU GDPR
- **Lawful basis.** Employee consent is presumed not freely given (Recital 43, Art. 7(4), EDPB Guidelines 05/2020). Employers normally rely on Art. 6(1)(f) legitimate interests, backed by a documented assessment. Consent can work only for a **truly optional** personal assistant where refusing has no consequence.
  - Recommendation: base the personal twin on voluntary opt-in that the employee controls. Base org aggregates on legitimate interests plus a works agreement.
- **Art. 88 (employment-specific national rules).** CJEU C‑34/21 (2023) cast doubt on generic national clauses such as BDSG §26. CJEU **C‑65/23 (19 Dec 2024)** held that works agreements must still comply with Arts. 5, 6(1) and 9; they cannot legalise processing the GDPR does not allow. Germany's Beschäftigtendatengesetz is still only a draft and is expected no earlier than late 2026 or 2027.
- **Art. 35 DPIA.** Company mode is effectively mandatory to assess: it combines systematic monitoring, employees as vulnerable data subjects and new technology (WP248 criteria). The CNIL and German DSK lists also include employee monitoring.
- **Art. 22 (automated decisions).** *SCHUFA* C‑634/21 read "decision" broadly, and *Dun & Bradstreet* C‑203/22 (2025) set the standard for explaining automated decisions. Twin output must never feed HR decisions. Autonomous actions that decide things about **other people** (approving leave, screening candidates) are also Art. 22 and AI Act Annex III territory.
- **Art. 9 (sensitive data) via browsing.** CJEU C‑252/21 *Meta v Bundeskartellamt* (2023) and C‑184/20 hold that data indirectly revealing a sensitive category counts as sensitive data. Visits to health, union, religious or political sites are therefore Art. 9 data. Exclude these categories by default.
- **Pseudonymous vs anonymous data.**
  - Pseudonymised data remains personal data for anyone holding the key (Recital 26, Art. 4(5)).
  - **EDPS v SRB, C‑413/23 P (4 Sep 2025):** pseudonymised data may *not* be personal data for a **recipient** that has no means reasonably likely to re-identify. It stays personal for the controller holding the key. This is a relative test.
  - The EDPB/EDPS still read the concept broadly. EDPB Guidelines 01/2025 on pseudonymisation were a Jan 2025 draft; whether a final version exists is unverified.
  - **Digital Omnibus, GDPR part:** the Council mandate of 21 Oct 2026 *keeps* the Art. 4(1) definition and adds a narrower Art. 25a on pseudonymisation. Parliament has not adopted its position and there is no trilogue yet. **Do not design around it.**
- **ePrivacy Art. 5(3).** Any telemetry the vendor reads from the device needs consent unless strictly necessary. Keep product analytics off by default.
- **Third-party data.** Screen and app capture records colleagues and customers. The household exemption (Art. 2(2)(c)) does not cover work use. Redact third-party identifiers before anything is stored.

### 2. EU AI Act (Reg. 2024/1689, as amended by the AI Omnibus)
- **Art. 5(1)(f)**, applicable since 2 Feb 2025 with fines of up to €35M or 7% since 2 Aug 2025, bans AI that infers **emotions (and, per the Commission guidelines, intentions)** of people in the workplace from biometric data. Exceptions are medical or safety use only.
  - Behavioural signals such as typing cadence and mouse dynamics plausibly count as biometric data under Art. 3(34).
  - Therefore no stress, frustration, engagement or burnout inference.
- **High-risk classification.**
  - **Annex III 4(b)** covers systems used to allocate tasks based on behaviour or traits, or to **monitor and evaluate the performance and behaviour** of workers.
  - **Art. 6(3) last subparagraph:** an Annex III system that profiles natural persons is *always* high-risk. The "narrow procedural task" escape is not available.
  - **Art. 26(7):** employers must inform workers' representatives and affected workers before deploying a high-risk system.
- **Dates.** The AI Omnibus, **Reg. (EU) 2026/1744** (published in the OJ 24 Jul 2026), moved Annex III obligations from 2 Aug 2026 to **2 Dec 2027** and Annex I-embedded systems to 2 Aug 2028. Art. 50 transparency has applied since 2 Aug 2026 (Art. 50(2) from 2 Dec 2026). The Art. 4 AI-literacy duty was softened to "support".
- **Positioning.** State the intended purpose (Art. 3(12)) as *personal task automation*, explicitly excluding worker evaluation. Back this with contract terms and technical limits. Build the org-analytics module as if it were high-risk anyway, ready by Dec 2027.
- **Watch item: the Quality Jobs Act.** It is the Commission proposal covering algorithmic management and excessive monitoring, targeted for 3 Dec 2026, likely a directive under Art. 153 TFEU.

### 3. National workplace rules
- **Germany, BetrVG §87(1) no. 6.**
  - Co-determination applies to any technical system *objectively suitable* for monitoring behaviour or performance; the employer's intent is irrelevant and there is no minimum threshold (BAG 1 ABR 43/12).
  - A works agreement (Betriebsvereinbarung) is a hard prerequisite for company rollout. Even with one, a disproportionate tool remains unlawful (BAG 1 ABR 46/15).
  - Covert keyloggers require a concrete suspicion of serious misconduct (BAG 2 AZR 681/16).
- **France (CNIL and Labour Code).**
  - Keyloggers, permanent screen sharing, automatic screenshots and always-on webcams are treated as excessive.
  - **SAN‑2024‑021** (€40k): screenshots every 3–15 minutes plus inactivity counting. Telling employees about it was "not sufficient".
  - **Amazon France Logistique SAN‑2023‑021:** €32M over granular productivity and idle indicators. The Conseil d'État reportedly reduced it to €15M on 23 Dec 2025.
  - Labour Code L1222‑4 requires prior information; L2312‑38 requires consulting the CSE (works council) first.
- **United Kingdom.**
  - ICO "Monitoring workers" guidance (Oct 2023): legitimate interests plus a documented assessment; consent rarely valid; DPIA expected where analytics infer things about workers.
  - The DUAA 2025 replaced Art. 22 with **Arts. 22A–22D from 5 Feb 2026** (SI 2026/82). Updated ICO ADM guidance was still in draft as of Aug 2026.
  - Workplace monitoring is not one of the new "recognised legitimate interests".
- **United States.**
  - **ECPA:** one-party consent (18 USC §2511(2)(d)) and the ordinary-course-of-business exception. Avoid audio or meeting capture, because all-party consent states such as Cal. Penal Code §632 apply.
  - **CCPA/CPRA:** employees have had full consumer rights since 1 Jan 2023. Email and message contents count as *sensitive personal information* unless the business is the intended recipient.
  - **CCPA regulations** (effective 1 Jan 2026) require a **risk assessment** for automated inference about people based on "systematic observation" at work. ADMT duties for significant decisions arrive in 2027 (sources disagree between 1 Jan and Apr 2027).
  - **New York Civil Rights Law §52‑c:** notice on hire plus acknowledgment plus posting. AG enforcement, $500 / $1k / $3k per violation.
  - **Connecticut PA 26‑73**, effective **1 Oct 2026**, replaces §31‑48d: notice must now name the locations monitored, plus on-site posting. $500 / $1k / $3k.
  - **Delaware 19 Del. C. §705:** daily notice, or one-time notice plus acknowledgment. $100 per violation.
  - **Maine LD 61 (2025):** notice, no surveillance in the employee's home or on personal property, and no mandatory apps on personal devices. **This matters for remote workers; verify the exact text.**
  - **California AB 1331:** reported chaptered 30 Sep 2026 (Ch. 851). Limits monitoring of residences unless strictly necessary and gives a right to disable tools off-duty. Single source; verify.
  - **FTC:** the *Avast* order (2024, $16.5M) punished selling "anonymized" browsing data. Misleading "anonymous" marketing is a deception risk.
- **India.**
  - DPDP Act 2023 and **Rules notified 13 Nov 2025**. Most obligations apply from **~13 May 2027**; consent-manager registration starts around Nov 2026.
  - Sec. 7(i) "legitimate uses" covers employment purposes and protecting the employer against loss, but commentators warn it is not a blanket licence for surveillance.
  - Breach notice to the Board is due within 72 hours.

### 4. Technique stack (concrete)
- **Data minimisation at capture.**
  - Record event metadata only: process or bundle ID, a *locally classified* window-title category, URL domain (not path), and action type.
  - **Never record keystroke content.** For screen understanding, OCR in memory on demand, redact, then discard the pixels.
  - Skip secure fields automatically: macOS `IsSecureEventInputEnabled` / `AXSecureTextField`, Windows UIA `IsPassword`. Skip private or incognito windows and DRM surfaces.
- **Redaction pipeline.**
  - Deterministic pass first: gitleaks/trufflehog-style secret rules (AWS `AKIA…`, PEM, JWT), Luhn check for card numbers, mod‑97 for IBANs, email and phone formats.
  - Then NER: Presidio Analyzer and Image Redactor. 2.2.360 (Sep 2025) added `redact_and_return_bbox`. Governance and current version unverified; some sources describe it as "ex-Microsoft".
  - On-device PII NER option: GLiNER (lib v0.2.27, ONNX export) or **Fastino GLiNER2‑PII** (300M parameters, May 2026; about 590 MB as FP16 ONNX, roughly 180 ms on CPU). Heavy, so consider distilling it.
  - OCR: Apple Vision, `Windows.Media.Ocr`, Tesseract on Linux.
- **Encryption at rest and keys.**
  - SQLCipher **4.17.0** (Jul 2026, fixes two CVEs) via rusqlite `bundled-sqlcipher`.
  - Wrap the database key in hardware-backed stores: macOS Keychain with Secure Enclave (P‑256 only, so wrap via ECIES); Windows CNG "Microsoft Platform Crypto Provider" (TPM) or DPAPI‑NG; Linux Secret Service/libsecret or TPM2 via tpm2‑tss; Argon2id passphrase as fallback.
  - Deletion is **crypto-shredding** (destroy the key).
  - Precedent: Windows Recall kept snapshots in a VBS enclave with a TPM key gated by Windows Hello, after its plaintext launch failed publicly.
- **Pseudonymous IDs.** Use a random device secret and rotating per-epoch IDs: `HMAC(device_secret, org_id‖epoch)`. Keep SSO, billing and license identity out of the analytics path. The employer and vendor never hold the mapping, which is the SRB "recipient lacks means" argument.
- **Org aggregates.**
  - **Minimum cohort k ≥ 10** contributors, with cells below that suppressed. Viva Insights precedent: floor of 5, manager views 10.
  - Add **central DP over secure aggregation**: IETF **DAP** (draft‑ietf‑ppm‑dap‑18; RFC status unverified) with **Prio3** VDAF, via Janus or Divvi Up.
  - DP mechanisms and budgets via **OpenDP 0.15.1** (Rust and Python) or the Google DP library, with a per-org ε budget ledger and per-user contribution bounding.
  - Local DP alone gives too little utility at org scale.
- **Federated learning and analytics.** Flower supports SecAgg/SecAgg+ and central or local DP with fixed or adaptive clipping. Prefer federated *analytics* on templates over federated model training.
- **LLM calls.**
  - Local-first: llama.cpp or ONNX Runtime, and Apple's on-device Foundation Models where available.
  - Cloud calls only on redacted payloads under zero data retention. Anthropic ZDR covers Messages and Token Counting for eligible features, is enabled on request, and some newer models require 30-day retention.
  - Confidential inference where possible: attested TEEs such as Azure or NVIDIA confidential-computing GPUs; Google Private AI Compute is the reference design.
- **User controls.** A visible capture indicator, a global pause hotkey, and per-app and per-domain exclusions. Default exclusions: password managers, banking, health, HR portals, personal messaging, incognito. Also:
  - private hours;
  - retention limits: raw events 7–14 days, derived patterns 90 days (recommended values);
  - JSON export;
  - a "what left my device" ledger.
- **Autonomy tiers.** Suggest, then draft, then run with confirmation, then autonomous only for allow-listed low-risk actions. Provide dry runs, undo and rate limits. No actions inside excluded apps and no HR decisions.

### 5. Proposed privacy model: "Personal Twin, Collective Insight"
1. **P1:** Raw data and the twin live only on the device, encrypted under a user-held key. The vendor stores nothing identifiable.
2. **P2:** No per-person employer view. No manager dashboard, no export, no "view twin" and no admin override, because no endpoint for any of it exists.
3. **P3:** Org insights are DP statistics over secure aggregation with k ≥ 10, about **workflows and apps**, never people. No rankings.
4. **P4:** Sharing is opt-in and per artifact. The employee previews a PII-scrubbed automation before publishing it, and attribution is optional.
5. **P5:** Rotating pseudonyms, with identity kept separate from telemetry.
6. **P6:** The twin models **tasks, not traits**: no productivity, emotion, health or other sensitive inferences.
7. **P7:** The employer cannot remotely enable capture, reduce exclusions, disable pause or install covertly. No personal devices, off-hours capture or home-only contexts.
8. **P8:** Honest wording: "private and pseudonymous by design; anonymous aggregates". Never "anonymous twin".
- Residual risks: singling-out through unique workflows in tiny teams, identifiers in free text inside shared automations, and timing side-channels. Mitigations: k and DP thresholds, a scrubber with diff review, and batched, delayed uploads.

### 6. Features to exclude (legally risky)
- Productivity or activity scores, idle/active time, per-person time-on-task, leaderboards (CNIL, Amazon, Annex III 4(b)).
- Keystroke content or dynamics logging, mouse tracking (WP249, BAG, CNIL).
- Periodic screenshots or screen recordings visible to anyone other than the user.
- Webcam or microphone capture; meeting audio by default.
- Emotion, stress, engagement, sentiment or intention inference about workers (Art. 5(1)(f)).
- Inferences about health, union membership, religion or politics; sensitive-site capture (Art. 9).
- Stealth or covert mode, or an agent the user cannot pause or uninstall.
- Monitoring on personal devices, off-duty or at home (Maine, California).
- Twin-driven HR decisions: hiring, task allocation by traits, discipline, attrition or flight-risk scores (Art. 22, Annex III 4(a)/(b)).
- Biometric presence verification.
- "100% anonymous" marketing (FTC).

### 7. Ship with company mode
A DPIA template, legitimate-interests assessment, Art. 13 notice, NY/CT/DE notice templates, a model Betriebsvereinbarung and CSE (French works council) consultation pack, the AI Act Art. 26(7) information notice, and a CCPA risk-assessment template.

Sources: [Gibson Dunn AI Omnibus](https://www.gibsondunn.com/eu-ai-act-omnibus-agreement-postponed-high-risk-deadlines-and-other-key-changes/), [FPF Omnibus timeline](https://fpf.org/blog/the-ai-act-implementation-timeline-what-changes-under-the-ai-omnibus/), [Clifford Chance on SRB](https://www.cliffordchance.com/insights/resources/blogs/talking-tech/en/articles/2025/09/pseudonymized-data-after-edps-v-srb.html), [Council GDPR omnibus mandate](https://euinternetpolicy.wordpress.com/2026/10/23/the-councils-digital-omnibus-mandate-what-it-would-change-in-the-gdpr/), [CMS on C‑65/23](https://cms.law/en/deu/legal-updates/european-court-of-justice-no-deviation-from-gdpr-standards-via-works-agreements), [FPF emotion recognition](https://fpf.org/blog/red-lines-under-eu-ai-act-unpacking-the-prohibition-of-emotion-recognition-in-the-workplace-and-education-institutions/), [CNIL SAN‑2024‑021](https://www.cnil.fr/fr/surveillance-excessive-des-salaries-sanction-de-40-000-euros-entreprise-secteur-immobilier), [Amazon fine on appeal](https://www.mind.eu.com/rh/en/article/amazon-france-logistique-employee-surveillance-fine-halved-on-appeal/), [ICO monitoring workers](https://ico.org.uk/for-organisations/uk-gdpr-guidance-and-resources/employment/monitoring-workers/data-protection-and-monitoring-workers/), [Travers Smith DUAA ADM](https://www.traverssmith.com/knowledge/knowledge-container/uks-data-protection-reforms-take-effect-a-new-era-for-automated-decision-making/), [White & Case CPPA rules](https://www.whitecase.com/insight-alert/cppa-finalizes-rules-admt-risk-assessments-and-cybersecurity-audits-requirements), [Jackson Lewis CT PA 26‑73](https://www.workplaceprivacyreport.com/2026/09/articles/monitoring-2/deadline-imminent-for-connecticuts-expanded-electronic-monitoring-law/), [Fisher Phillips Maine LD 61](https://www.fisherphillips.com/en/news-insights/maine-sets-new-restrictions-on-workplace-monitoring-and-surveillance.html), [AB 1331](https://calmatters.digitaldemocracy.org/bills/ca_202520260ab1331), [DPDP Rules](https://www.hoganlovells.com/en/publications/indias-digital-personal-data-protection-act-2023-brought-into-force-), [WP249 summary](https://www.rpc.co.uk/snapshots/data-protection/data-protection-working-party-adopts-opinion-22017-on-data-processing-at-work), [Quality Jobs Act](https://remoteworkeurope.eu/news/2026/eu-quality-jobs-act-december-adoption-target/), [Viva Insights privacy](https://learn.microsoft.com/en-us/viva/insights/advanced/setup-maint/privacy-settings), [Anthropic data retention](https://platform.claude.com/docs/en/build-with-claude/api-and-data-retention), [Zetetic SQLCipher](https://www.zetetic.net/blog/2026/05/12/sqlcipher-4.16.0-release/), [OpenDP crate](https://docs.rs/crate/opendp), [DAP draft‑18](https://www.ietf.org/archive/id/draft-ietf-ppm-dap-18.xml), [Recall architecture coverage](https://digitaltrends.com/computing/microsoft-recall-security-architecture-in-recall), [Google Private AI Compute](https://www.infoq.com/news/2025/11/google-private-ai-compute-tee).

## Key decisions
- **What 'anonymous' means in the product and its marketing** → Say 'private and pseudonymous by design; anonymous aggregates'. Never call the twin itself anonymous. Anonymity applies only to what the vendor and employer receive. — _A twin of one person is profiling of an identifiable person (GDPR Art. 4(4)). EDPS v SRB (C-413/23 P) supports anonymity only for recipients that cannot re-identify, and the EDPB still reads the concept broadly. The FTC's Avast order punished misleading 'anonymized' claims._
- **Core data architecture** → Keep raw capture and the twin on the device in SQLCipher, with the key wrapped by Secure Enclave, TPM or Secret Service and held only by the user. Delete by crypto-shredding. The vendor stores nothing identifiable. — _This minimises controller exposure for the vendor and gives the employee real ownership. It also follows the Recall lesson: plaintext local stores destroy trust._
- **What the employer can see in company mode** → Only DP statistics over secure aggregation (DAP/Prio3 plus OpenDP) with a minimum cohort of k>=10, about workflows and apps, plus automations employees explicitly publish. No per-person endpoint exists. — _This keeps the product outside AI Act Annex III 4(b) worker evaluation and away from the indicators behind the CNIL and Amazon fines. It also removes the reason for a BetrVG fight over individual monitoring._
- **Capture scope** → Capture event metadata only: app or process, a locally classified window category, URL domain, action type. OCR on demand and in memory, then redact and discard. No keystroke content, no periodic screenshots, no audio or webcam. Auto-skip secure input fields and incognito windows. — _WP249, the CNIL and the BAG treat keyloggers and screenshots as disproportionate. Audio raises all-party-consent wiretap issues. Browsing can reveal Art. 9 sensitive data (C-252/21)._
- **Lawful basis and deployment packaging for company mode** → Treat the employer as the controller of the deployment. Make the personal twin voluntary with no penalty for refusing; base aggregates on legitimate interests plus a works agreement. Ship a DPIA, LIA, notices (NY/CT/DE), a model Betriebsvereinbarung, a CSE pack, an Art. 26(7) notice and a CCPA risk-assessment template. — _Joint controllership does not require access to the data (C-210/16). Employee consent is presumed invalid. BetrVG §87(1) no. 6 applies to any system objectively able to monitor. C-65/23 says works agreements must still meet Arts. 5, 6 and 9._
- **Cloud LLM usage** → Local models first. Cloud calls only after deterministic and NER redaction, under zero data retention, in a chosen region, and on attested confidential-compute endpoints where available. Log every outbound call in a ledger the user can see. — _Anthropic ZDR is enabled on request and excludes some models and features, so eligibility must be checked. Confidential inference (Private AI Compute style) reduces trust needed in the provider._
- **Autonomy ('make it work itself')** → Tiered autonomy: suggest, then draft, then run with confirmation, then autonomous only for allow-listed low-risk actions, with dry runs, undo and rate limits. Never automate HR decisions or decisions about other people. — _GDPR Art. 22 (broad 'decision' per SCHUFA) and UK Arts. 22A-D apply. AI Act Annex III 4(a)/(b) is high-risk from 2 Dec 2027._
- **AI Act positioning** → Define the intended purpose as personal task automation and exclude worker evaluation in both terms and code. Build org analytics to high-risk standards before 2 Dec 2027. Never infer emotion or intention from behavioural signals. — _Art. 5(1)(f) has been in force since Feb 2025. Under Art. 6(3), any Annex III system that profiles is always high-risk. Reg. (EU) 2026/1744 moved the Annex III date to 2 Dec 2027._

## Risks
- The employer is likely a (joint) controller even with on-device-only processing, so it cannot avoid DPIA, lawful-basis, works-council and notice obligations.
- BetrVG §87(1) no. 6 objective-suitability test: in Germany, even the aggregate-only design needs a works agreement before rollout.
- Treating behavioural signals (typing cadence, mouse dynamics) as biometric data could turn any 'focus', 'stress' or 'engagement' feature into a prohibited Art. 5(1)(f) practice.
- Singling out in small teams or with unique workflows can re-identify people from aggregates; DP noise destroys usefulness for tiny cohorts.
- Shared automations can carry PII or secrets in free text, selectors or recorded values, so a scrubber with diff review is needed.
- Screen and app capture collects third-party personal data (customers, colleagues); the household exemption does not apply.
- Remote-work home monitoring may conflict with Maine LD 61 and California AB 1331 (if chaptered).
- User-held keys conflict with employer legal-hold or e-discovery and regulated recordkeeping duties (e.g. financial services); needs a policy decision.
- The GDPR Digital Omnibus outcome is unknown (Parliament position pending); designing around a relative definition of personal data is premature.
- The EU Quality Jobs Act proposal (target 3 Dec 2026) may add algorithmic-management and monitoring rules on top of the GDPR and the AI Act.
- Cloud LLM ZDR eligibility varies by model and feature; newer models may require 30-day retention.
- Misleading 'anonymous' marketing creates FTC Section 5 and EU unfair-practice exposure.
- On-device PII NER models are large (~590 MB as FP16 ONNX for GLiNER2-PII), which affects install size and CPU use.

## Unverified
- California AB 1331: reported chaptered 30 Sep 2026 as Ch. 851 (Digital Democracy only); other sources said it failed in Jan 2026.
- Maine LD 61: exact scope of the home-surveillance ban, effective date, and enforcing agency (Dept. of Labor vs AG).
- CCPA ADMT compliance date for significant decisions (1 Jan 2027 vs Apr 2027) and the exact regulation section numbers.
- Conseil d'État reduction of the Amazon France Logistique fine to €15M (23 Dec 2025); one source says it was upheld.
- Whether EDPB Guidelines 01/2025 on pseudonymisation were finally adopted.
- Whether the Commission's Art. 5 guidelines explicitly treat keystroke or mouse dynamics as biometric data for the emotion-recognition ban.
- Exact AI Act Art. 26(7) wording ('where applicable in accordance with Union and national law' qualifier).
- Reg. (EU) 2026/1744 entry-into-force date (27 Jul 2026 per one source) and the Art. 50(2) grace-period details.
- IETF DAP and VDAF RFC status (last seen as draft-ietf-ppm-dap-18).
- Presidio's current version and governance ('ex-Microsoft' claims); Flower's current release number.
- DPDP full-obligation date (13 vs 12 May 2027) and whether the Rules require notifying data principals of breaches.
- Final status of the ICO ADM/profiling guidance under DUAA (draft Mar 2026); whether 'recognised legitimate interests' exclude workplace monitoring (stated from memory).
- Whether Apple Private Cloud Compute is available to third-party developers (assumed not); the Foundation Models framework description is from memory.
- Viva Insights default minimum group size (sources give 5, 10 or 25 by feature) and whether it uses DP.
- The recommended k>=10, retention limits (7-14 / 90 days) and epsilon budget are design recommendations, not legal requirements.
- FTC Avast order details ($16.5M, 2024) and CJEU C-203/22 / C-634/21 holdings were stated from prior knowledge without re-fetching.
