# DPIA outline: companyOS Twin, company deployment

> **DRAFT. Not legal advice. For review by qualified counsel before any use.**
>
> Draft v0.1, 2026-10-31. Template built from [`docs/research/privacy-legal.md`](../research/privacy-legal.md) and [`docs/plan/README.md`](../plan/README.md) (§3, §5, §7, §8, §13, §14, §16). No lawyer has reviewed it.
>
> Legend: **[SQUARE BRACKETS]** are facts the company or counsel must supply. Do not fill them from assumptions. **CONFIRM** marks a product statement taken from the plan or research that must be checked against the build actually deployed. **OI-n** refers to the open items in section 8.

## 1. Purpose and scope

- This outline follows the minimum content of a data protection impact assessment under GDPR Art. 35(7): (a) a systematic description of the processing and its purposes, (b) an assessment of necessity and proportionality, (c) an assessment of the risks to rights and freedoms, and (d) the measures planned to address those risks.
- **Scope:** deployment of companyOS Twin by [COMPANY NAME] to employees in [JURISDICTION AND PILOT SITE] (plan §10, Phase 3). It covers the company-mode data flows in section 3.2 and the personal-twin data flows on each employee's device.
- **Out of scope:** any use that is not a company deployment, and any processing by [VENDOR NAME] that falls outside the product, which needs its own assessment.
- **Owner:** [NAME, ROLE]. **Assessment date:** [DATE]. **Review:** before each release that changes capture, aggregation or retention, and at least every [PERIOD].

## 2. Screening: why an assessment is needed

The research identifies these criteria as likely to apply (privacy-legal §1, §4). Counsel to confirm.

| Criterion | Basis in the research | Assessment |
|---|---|---|
| Systematic monitoring | Capture of app and workflow activity over time on work devices | Applies |
| Vulnerable data subjects | Employees depend on the employer | Applies |
| New technology | On-device capture, pattern learning and automation | Applies |
| Evaluation or scoring | Not designed in: no individual score, rank or productivity metric (plan §8.1) | CONFIRM for every feature |
| Sensitive data | Browsing can reveal Art. 9 categories (CJEU C-252/21) | Possible. Mitigated by exclusions (section 4.2) |
| Scale | [NUMBER OF EMPLOYEES AND DEVICES IN THE PILOT] | [COUNSEL] |

The CNIL and German DSK lists also name employee monitoring (privacy-legal §1).

## 3. Systematic description of the processing

### 3.1 Parties and roles

| Party | Proposed role (counsel to confirm) | Access to personal data |
|---|---|---|
| [COMPANY NAME], employer | Controller of the company deployment. Joint-controller exposure remains even with on-device processing (privacy-legal §0, C-210/16) | Aggregates only (section 3.3). No individual data by design |
| Employees | Data subjects, and owners of their own twin | Full access on their own device |
| [VENDOR NAME] | [CONTROLLER, PROCESSOR, OR NO ROLE FOR PERSONAL DATA] | Design target: nothing identifiable. CONFIRM, including any telemetry (ePrivacy Art. 5(3)) |
| Works council or CSE | Consulted. Co-determination applies (see the works-council note) | Aggregates only |
| Model download hosts | Recipients of download requests | Connection data, such as IP address. No activity data. [CONFIRM HOST NAMES] |

### 3.2 Data flows

| Stage | Data | Location | Retention |
|---|---|---|---|
| Capture | App or process name; window category (OI-1); browser domain, not path (privacy-legal §4). The shipped MVP also drops titles. Plan §5.1 lists browser title too (OI-1); idle and lock state; action type | Device | Section 3.5 |
| Input signals | [Counts and shortcut chords (plan D7), or none (privacy-legal §6). OI-2] | Device | [SET] |
| Screen reading, opt-in only | OCR in memory on demand. Output redacted, then discarded. No screenshots saved | Device | None kept |
| Redaction | Secrets, card and bank numbers, email and phone formats. Secure fields skipped | Device | Not stored |
| Twin model | Routines, automation candidates, pseudonymous IDs from a per-device secret | Device, encrypted | Until deleted by the user |
| Automations and autonomy levels | Approved automations and each one's autonomy level | Device | Until removed by the user |
| Published automation | Copy after the employee previews and scrubs it, with attribution optional | Company library | [SET] |
| Aggregates | Differentially private counts over cohorts of at least [10] people, about workflows and apps only | Secure aggregation, then the employer | [SET] |
| Network ledger | Record of outbound connections | Device | [SET] |

**Encryption and keys.** The target design is an encrypted SQLCipher store with the key sealed by the OS keychain or secure element (plan §4, privacy-legal §4). The current MVP uses record-level AES-256-GCM over an append-only log, with the key from the OS keychain (plan §16). The assessment must describe whichever build is deployed. Deletion is by destroying the key (crypto-shredding).

### 3.3 Aggregates

- **Subjects:** workflows, apps used and automation adoption. Never individuals (plan §8.2).
- **Minimum cohort:** k ≥ 10. Cells below the threshold are suppressed. The threshold is a design recommendation, not a legal requirement (plan §14). [COMPANY: define cohorts. State what happens to a team smaller than k.]
- **Method:** differential privacy over secure aggregation (DAP with Prio3, using OpenDP, plan §8.2, privacy-legal §4). **Privacy budget:** [SET]. This is a design recommendation until counsel accepts it.
- **Residual risk:** singling out through unique workflows in small teams (privacy-legal, Risks section). Scored in section 5.

### 3.4 Purposes

1. **Personal task automation** for the employee who owns the twin: suggest, then draft, then run with confirmation, and only then run autonomously for allow-listed, low-risk actions (plan §7).
2. **Company purpose:** [COMPANY: state the specific business purpose. Counsel must test it against purpose limitation (Art. 5(1)(b))].

**Excluded uses** (to appear in the works agreement too): performance evaluation, ranking, idle-time or time-on-task metrics, HR decisions about any person, inference of emotion, stress, focus or engagement (AI Act Art. 5(1)(f)), and inference of health, union, religion or political views.

### 3.5 Retention

| Data | Research recommendation (privacy-legal §4) | Shipped MVP (docs-site/privacy.mdx) | Decision |
|---|---|---|---|
| Raw events | 7 to 14 days | Kept 90 days, then removed | [DECIDE] |
| Derived patterns | 90 days | Routines and automations kept until removed | [DECIDE] |
| Aggregates | Not stated | Not applicable | [DECIDE] |

### 3.6 Data subjects and categories

- Employees who use the app.
- **Third parties** on screen, such as colleagues and customers. The household exemption (Art. 2(2)(c)) does not cover work use (privacy-legal §1). Identifiers are redacted before storage.
- **Special categories (Art. 9)** can arrive indirectly through browsing (C-252/21). Default exclusions apply (section 4.2).

### 3.7 Transfers

- Personal data leaves the device only in the flows listed in section 3.1.
- **CONFIRM** that no cloud model calls exist. The plan removes them (§15a). If any are added, a transfer assessment is required.
- [CONFIRM the location of any vendor infrastructure and the transfer mechanism, if any.]

## 4. Necessity and proportionality

### 4.1 Lawful basis (counsel to confirm for each stream)

| Stream | Proposed basis (privacy-legal §0, §1) | Status |
|---|---|---|
| Personal twin on the employee's device | Voluntary opt-in. Consent is valid only if refusing has no consequence (Art. 7(4), Recital 43) | Draft. Counsel to confirm |
| Company aggregates | Art. 6(1)(f) legitimate interests, backed by a documented assessment, plus a works agreement (Art. 88; C-65/23) | Draft. The legitimate-interests assessment is a separate deliverable and is not yet drafted |
| Any mandatory component | None proposed | [IF ANY: state the basis] |

**National rules to address:**
- **Germany:** BetrVG §87(1) no. 6. A works agreement is required before rollout, even for an aggregate-only design (plan §8.3).
- **France:** Labour Code L1222-4 (prior information) and L2312-38 (CSE consultation before the decision).
- **UK:** ICO guidance on monitoring workers, if the pilot is in the UK (privacy-legal §3).
- **United States:** state notice laws are handled in separate documents (privacy-legal §3).

### 4.2 Alternatives considered and exclusions

| Feature | Decision | Reason |
|---|---|---|
| Keystroke content | Excluded | WP249, BAG and CNIL treat it as disproportionate (privacy-legal §6) |
| Keystroke counts and shortcut chords | OI-2 | Included in plan D7. Excluded by privacy-legal §6 ("keystroke dynamics logging") |
| Periodic screenshots visible to others | Excluded | CNIL SAN-2024-021 (privacy-legal §3) |
| Webcam, microphone, meeting audio | Excluded | Privacy-legal §6. ECPA and Cal. Penal Code §632 risk |
| Per-person manager dashboard | Excluded | Plan §8.1. No endpoint exists |
| Emotion, stress, focus or engagement inference | Excluded | AI Act Art. 5(1)(f) |
| Twin-driven HR decisions | Excluded | Art. 22 GDPR and AI Act Annex III 4 (privacy-legal §1 and §2) |
| Capture on personal devices, off duty or at home | Excluded | Privacy-legal §6. Maine LD 61 and California AB 1331 (both unverified) |

### 4.3 Information and rights

- **Art. 13 notice:** see [`privacy-notice-draft.md`](privacy-notice-draft.md).
- **Rights:** the shipped MVP supports export as JSON and delete everything on the device. How the company handles requests it cannot fulfil itself is [COUNSEL].
- **Art. 22:** the app takes no decisions with legal or similarly significant effects on employees. Actions are limited to the employee's own tasks and run only after approval within the employee's autonomy level. CONFIRM.

## 5. Risk assessment

The company scores likelihood and severity with its own method: [SCALE]. Residual risk is left to be scored.

| # | Risk | Planned measure | Status | Residual |
|---|---|---|---|---|
| R1 | Capture beyond the approved scope (for example, screenshots or keystrokes) enabled by an admin or an update | Capture scope fixed in code. Admins cannot enable capture remotely or reduce exclusions (plan §8.1; privacy-legal §5, P7). Privacy tests in CI (plan §9.2). Independent review before beta (plan §12) | Design. CONFIRM | [SCORE] |
| R2 | Re-identification of people from aggregates in small groups | Cohorts of at least k=10, suppression, differential-privacy noise, no rankings | Design. CONFIRM parameters | [SCORE] |
| R3 | Sensitive categories revealed through browsing | Domain-only capture. Default exclusions for health, union, religion, politics, HR portals, banking, personal messaging, password managers and private windows | Design. CONFIRM list | [SCORE] |
| R4 | Personal data of colleagues and customers captured | Redaction. Secure fields skipped. App exclusions | Design. CONFIRM | [SCORE] |
| R5 | Secrets or personal data in published automations | Preview before sharing. Scrubber with diff review. Optional attribution | Design. Scrubber accuracy untested | [SCORE] |
| R6 | Loss or theft of a device | Encrypted store. Key in OS secure storage. Crypto-shredding on delete | Partly built (plan §16) | [SCORE] |
| R7 | Output used for HR decisions or performance management | Contract ban. No per-person API. Works agreement | Contract and policy to draft | [SCORE] |
| R8 | Emotion, focus or engagement inferred from input behaviour | Excluded by design | Needs a review gate for every new signal | [SCORE] |
| R9 | Vendor receives telemetry or identifiable data | Analytics off by default. No identifiable data by design | CONFIRM in the shipped build | [SCORE] |
| R10 | Misleading "anonymous" claims | Wording rule: "private and pseudonymous by design; anonymous aggregates" (plan §3) | Counsel to confirm (plan §13, question 6) | [SCORE] |
| R11 | Legal hold or e-discovery needs access to user-held data | None yet | Policy decision (plan §13, question 7) | [SCORE] |
| R12 | Security incident | Incident procedure. Notification to the supervisory authority within 72 hours (Art. 33) | [TO WRITE] | [SCORE] |
| R13 | Monitoring at home, off duty or on personal devices | Excluded from capture | CONFIRM for each jurisdiction | [SCORE] |

## 6. Consultation

- **Works council or CSE:** see [`works-council-information-note.md`](works-council-information-note.md). Record the opinion here: [DATE, OUTCOME].
- **Employee representatives and affected employees:** [METHOD, for example pilot-group feedback].
- **Data protection officer (Art. 35(2)):** [NAME, OR "NOT APPOINTED; COUNSEL TO CONFIRM WHETHER REQUIRED"].
- **Vendor, as processor:** [INPUT, IF ANY].
- **Prior consultation (Art. 36):** required if residual high risk remains. [COUNSEL TO DECIDE].

## 7. Measures and sign-off

| Measure | Owner | Status | Evidence |
|---|---|---|---|
| Capture scope fixed in code, with privacy tests | [OWNER] | [STATUS] | [LINK] |
| Admin controls matrix (plan §8.1) | [OWNER] | [STATUS] | [LINK] |
| Retention jobs implemented | [OWNER] | [STATUS] | [LINK] |
| Works agreement signed | [OWNER] | [STATUS] | [LINK] |
| Independent review before beta | [OWNER] | [STATUS] | [LINK] |

**Sign-off:**
- Controller representative: [NAME, ROLE, DATE]
- Data protection officer: [NAME, DATE]
- Counsel review: [NAME, DATE]
- Works council acknowledgment: [DATE]

## 8. Open items for counsel

1. **OI-1 Window and page titles.** The plan's capture matrix includes the browser URL and title, captured by the extension (plan §5.1). The research recommends a locally classified window category and URL domain only (privacy-legal §4). The shipped privacy page says titles and query strings are dropped (docs-site/privacy.mdx). Decide one position, and make this assessment and the notice match it.
2. **OI-2 Keystroke counts and shortcut chords.** Plan D7 includes them. Privacy-legal §6 excludes keystroke dynamics. Decide before the pilot.
3. **OI-3 Retention.** Set the periods in section 3.5.
4. **OI-4 Roles.** Confirm controller, processor and joint-controller status for the employer and the vendor.
5. **OI-5 Lawful basis.** Confirm the basis for each stream, and draft the legitimate-interests assessment.
6. **OI-6 Personal data and the aggregates.** EDPS v SRB (C-413/23 P) makes the test relative to the recipient. Confirm the position for the employer, and confirm that the privacy parameters are adequate. They are design recommendations only.
7. **OI-7 Legal hold and e-discovery.** User-held keys conflict with some regulated recordkeeping duties (plan §13, question 7).
8. **OI-8 Jurisdiction.** Confirm the pilot site (plan §13, question 5). Obligations not covered here include US state notices, the UK Data (Use and Access) Act 2025 automated-decision rules, and India's DPDP Act, which applies from about May 2027 (privacy-legal §3).
9. **OI-9 AI Act.** Art. 26(7) information duty. High-risk obligations for Annex III from 2 December 2027 (privacy-legal §2). Watch the Quality Jobs Act proposal.
10. **OI-10 Unverified sources.** Check each entry in the "Unverified" section of privacy-legal.md before this assessment is signed. This includes Maine LD 61, California AB 1331, the CCPA dates and the EDPB pseudonymisation guidelines.
