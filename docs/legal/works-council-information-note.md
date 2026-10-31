# Information note for the works council: companyOS Twin

> **DRAFT. Not legal advice. For review by qualified counsel before any use.**
>
> Draft v0.1, 2026-10-31. Template built from [`docs/research/privacy-legal.md`](../research/privacy-legal.md) and [`docs/plan/README.md`](../plan/README.md) (§8, §12, §13). No lawyer has reviewed it.
>
> **Note to the company.** Adapt this note to the jurisdiction. The local term for the body (Betriebsrat, CSE, ondernemingsraad or other) and the consultation steps must come from counsel. The German and French texts must be prepared by counsel. Do not send this draft to the works council until the open items in [`dpia-outline.md`](dpia-outline.md) section 8 are resolved. Items in **[SQUARE BRACKETS]** are placeholders. **CONFIRM** marks a product statement to check against the build deployed.

---

**To:** [WORKS COUNCIL OR CSE NAME]
**From:** [COMPANY NAME], [ROLE]
**Date:** [DATE]
**Subject:** Planned introduction of companyOS Twin at [PILOT SITE]

## 1. Purpose of this note

This note informs the works council before any decision is made about introducing companyOS Twin. It describes the software, the data it handles, the limits we propose and the works agreement we propose to negotiate.

**No decision has been taken.** [COMPANY AND COUNSEL: set out the consultation or co-determination steps and timetable required in [JURISDICTION].]

## 2. What is proposed

- **Pilot:** [NUMBER] employees on [NUMBER] devices at [PILOT SITE], from [START DATE] to [END DATE].
- **Devices:** [company-managed devices only. CONFIRM. Personal devices are excluded (privacy-legal §6).]
- **Software:** companyOS Twin, a desktop application for [PLATFORMS AS SHIPPED].
- **What it does:** it learns repeated computer tasks for each user, suggests automations and runs the automations the user approves. Each user sets how much the app may do on its own.
- **What the company sees:** statistics about workflows and applications used across groups of at least [10] people. No view of an individual exists.

## 3. What data is collected

| Category | Collected? | Notes |
|---|---|---|
| App names | Yes | [CONFIRM] |
| Window titles | [DECIDE. OI-1] | |
| Browser: website domain | Yes, when browser capture is on | Not the full address, page text or query strings. Private and incognito windows are never recorded. [CONFIRM. OI-1] |
| Idle and lock state | Yes | [CONFIRM] |
| Key counts and shortcut chords | [DECIDE. OI-2] | Never the content of what is typed |
| Screen content | No, unless the user opts in | If opted in: read in memory, redacted, then discarded. Screenshots are not saved |
| Typed text, passwords, clipboard | No | Secure fields are skipped |
| Webcam, microphone, meeting audio | No | |
| Personal devices, off-hours and home-only contexts | No | [CONFIRM for each jurisdiction] |

## 4. What the company receives

Statistics only. The subjects are workflows, the apps used and the adoption of automations. The method is differential privacy over secure aggregation, and cells for groups smaller than [10] are suppressed. The company receives no data about any individual, no ranking, no idle-time figures and no per-person score.

## 5. Purpose and limits

**Purpose:** [COMPANY: state the purpose.]

**The company undertakes that the system will not be used for:**
- evaluating the performance or behaviour of any employee;
- ranking employees or teams on individual measures;
- measuring idle time or time on task per person;
- decisions about hiring, pay, promotion, allocation of tasks or discipline;
- inferring emotion, stress, focus or engagement (AI Act Art. 5(1)(f));
- inferring health, union membership, religion or political views;
- any covert mode. The agent's state is visible to employees at all times (plan §8.3). [CONFIRM, including on managed devices, where the employee can still see the pause control.]

## 6. Data protection

- **Data protection impact assessment:** [STATUS AND DATE]. A copy is available to the works council on request.
- **On-device encryption:** data is encrypted on the device, and the key is kept in the device's secure storage. [CONFIRM that the company and the vendor hold no copy of the key. OI-7 on legal hold.]
- **Retention:** raw events for [X] days. Derived patterns for [X] days. Routines and automations until the user deletes them. [DECIDE. OI-3.]
- **Vendor:** [VENDOR NAME] receives no identifiable data. [CONFIRM, and list any telemetry.]
- **Network ledger:** the device records every outbound connection, and the user can read the ledger.
- **Security incidents:** [PROCEDURE, including notification to the supervisory authority and to the works council].

## 7. Proposed works agreement: heads of terms

These are negotiating proposals, not final terms.

1. **Scope:** the devices, users and site covered, and what is excluded.
2. **Voluntariness:** the personal assistant is optional. Declining has no effect on employment.
3. **Excluded uses:** as in section 5.
4. **Fixed capture scope:** any change to what is captured, the exclusions, the aggregation or the retention needs a new written agreement and an update to the impact assessment. This applies to software updates made through device management.
5. **Aggregates:** minimum group size [10]. Suppression of smaller cells. No individual data flows to the company.
6. **User controls:** pause, exclusions, autonomy levels, export and deletion. Administrators can switch the agent off remotely as a safety brake (plan §8.1), but cannot override these controls.
7. **Audit:** the ledger and a change log are available to the works council. An independent review of the privacy controls before [BETA OR PILOT STAGE], with results shared with the works council.
8. **Legal hold:** the procedure for regulated record-keeping, to be agreed. [OI-7]
9. **Review and exit:** a review every [PERIOD]. A right to suspend the pilot. Exit and deletion procedure.
10. **Disputes:** [PROCEDURE].
11. **Scope of monitoring:** no capture on personal devices, outside working hours or in home-only contexts. [CONFIRM]

## 8. Information for employees

Before the pilot starts, every employee in scope receives:
- the privacy notice (draft in [`privacy-notice-draft.md`](privacy-notice-draft.md));
- the AI Act Art. 26(7) information notice [NOT YET DRAFTED];
- the model works agreement [NOT YET DRAFTED; the product plan provides for one, plan §8.3].

## 9. Questions the works council may ask

The company should prepare answers before the consultation:
- How can the council check, on a device, what is being captured?
- Who can change the configuration, and how are changes recorded?
- How are exclusions enforced, and can a user see them?
- What happens to a team smaller than [10]?
- Who can read the ledger and the change log?
- What happens to a person's data when they leave the company?
- Can the council see the results of the independent review?
- What happens if the vendor is acquired or stops supporting the product?

## 10. Documents

| Document | Status |
|---|---|
| Data protection impact assessment outline ([`dpia-outline.md`](dpia-outline.md)) | Draft |
| Employee privacy notice ([`privacy-notice-draft.md`](privacy-notice-draft.md)) | Draft |
| Legitimate-interests assessment | Not yet drafted |
| Model works agreement | Not yet drafted (counsel) |
| French CSE consultation pack, if the pilot is in France | Not yet drafted |
| Translations | Not yet prepared |

## 11. Legal references for counsel to verify

These references are taken from the research. Counsel must verify each one before this note is sent.

- **Germany:** BetrVG §87(1) no. 6. Co-determination applies to any technical system objectively suitable for monitoring behaviour or performance. The Federal Labour Court decisions cited in privacy-legal §3 are 1 ABR 43/12 and 1 ABR 46/15. The Employee Data Act (Beschäftigtendatengesetz) is still a draft (privacy-legal §1).
- **France:** Labour Code L1222-4 (prior information of employees) and L2312-38 (consultation of the CSE before the decision). CNIL decision SAN-2024-021 (privacy-legal §3).
- **EU:** CJEU C-65/23. Works agreements must still meet GDPR Arts. 5, 6(1) and 9 (privacy-legal §1).
- **Netherlands or other jurisdictions:** if the pilot is not in Germany or France, replace this section with that jurisdiction's rules.
- **Unverified items:** check the "Unverified" section of privacy-legal.md before sending this note.
