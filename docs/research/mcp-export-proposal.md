# Research: exporting twin data through MCP (proposal)

Status: proposal, no code. Written 2026-10-31 against origin/main (0b95130). The decisions this needs are in section 9.

## 0. Summary
- **Export automations before data.** Plan §10 Phase 2 names MCP for automations ("Automations exported as MCP tools or agent skills"). Build that surface first. A caller can list automations and read run status. It can start an automation only through the local policy engine, with a native confirmation on the device when policy requires one. Results carry status, never content.
- **Twin-data reads are a second, optional surface.** The plan does not describe them yet. If the owner wants them, the only default that fits the plan is structure: app and action tokens, URL templates, routine and parameter names and types, and cadence counts. No values, screens, raw events, keys or identity mapping.
- **Every MCP response is egress.** §15a says no hosted model receives any data. companyOS cannot see what an MCP client does with a response, and cannot tell whether a client's model is hosted. So no third-party client should receive twin data in v1.
- **Build it default-deny.** Use a field allowlist in one module, run the §5.3 redaction on every outgoing string, write a ledger entry for each call, and add MCP responses as an output surface in the privacy leak tests.

## 1. Context
The plan has no MCP data export yet. What it does say:
- §7.2 makes MCP the first execution tier, at the spec revision named there.
- §10 Phase 2 lists "MCP tools. Automations exported as MCP tools or agent skills."
- prior-art.md (and decision D14) say to export automations as tools that any agent can run, rather than compete with agents.
- privacy-legal.md §4 lists a JSON export for the owner. §5 (P2) says no employer-facing export exists.

So "export twin data through MCP" would be a new egress path that the plan does not describe. This proposal sets its limits before anyone builds it.

## 2. Constraints from the plan

| Constraint | Source | Consequence for MCP |
|---|---|---|
| Raw data stays on the device | §1, principle 1 | Raw events, values and screens are never returned. |
| The twin is private and pseudonymous, not anonymous | §3, privacy-legal §0 | Describe exports as "private and pseudonymous". A single person's export cannot be called anonymous (the FTC Avast order is the precedent). |
| Cloud layer: abstracted traces only, preview first, ledger | §3, §6.3 | An MCP read that reaches a hosted client carries the same risk as a cloud call. Use the same abstraction ceiling, preview and ledger. |
| Open models only; no closed or hosted model receives data | §15a | Any client that forwards results to a hosted model is out of scope. |
| Redaction at source: secure fields, private windows and excluded apps are skipped; structure is stored, not content | §5.3 | Export inherits this. Element labels are structure, but still pass the redaction passes. |
| The employer sees only k ≥ 10 aggregates; admins cannot read twin data | §8.1, §8.2 | MCP is not an admin channel. Admins may disable it. They may not enable it or read through it. |
| No emotion, focus, engagement, stress or per-person score | §8.4, AI Act Art. 5(1)(f), §1 | No such field in any export or tool. |
| Policy decides before each step; money, outbound messages, deletion and permissions always need approval | §1, principle 3; D11; §7.4 | An MCP caller cannot approve its own action. |
| Tool annotations from servers are untrusted | §7.2; automation-autonomy.md | Effect classes come from companyOS's own policy, not from annotations. |
| The OpenMausBot handoff is not recorded in the network ledger | §16 | MCP would have the same gap. Close both. |

## 3. What could be exposed

### 3.1 Automation surface (first)

| Tool | Returns | Notes |
|---|---|---|
| `list_automations` | id, owner-approved name, step count, autonomy level | Names need owner review before export, because the naming step can pull context into them. |
| `get_run_status` | run id, state, step names, pass or fail, timestamps | No window titles, field values or screen content. |
| `run_automation` | run id and outcome status | Parameters are checked against typed schemas. Each step goes through policy evaluation. A step that needs approval raises a native confirmation on the device, as the OpenMausBot handoff does (§16). The caller cannot answer it. Not in the first build: it needs execution tiers beyond app focus, which §16 says are not built yet. |

Strings returned to a caller are length-capped and marked as data. Automation output is never raw screen text.

### 3.2 Twin-data surface (optional, later)

| Tier | Content | Default |
|---|---|---|
| A. Structure | App and action tokens, window category, URL templates (no path, query, fragment or userinfo), dwell buckets, routine and automation names, parameter names and types, cadence counts (for example `freq_14d`) | Off. Opt in per client. |
| B. Summary | Bucketed aggregates over the owner's own data: routines detected in a period, top apps by dwell bucket, suggestion acceptance rate (§6.4) | Off. Opt in per export. No per-event timeline. |
| Element labels (§5.4) | Accessibility labels | Off in v1. Add only after the redaction passes are shown to work on labels. |

Rules for every tier:
- **Per-export pseudonyms.** Each export gets a random ID map. The stable device and subject IDs (`d_7f3a`, `p_91c2` in §5.4) and the map itself are never returned, so two exports cannot be joined on IDs.
- **Pull only, paginated, size-capped.** No subscriptions or push, since a push channel would let a client drain data continuously. handoff.ts defines a read limit (`HANDOFF_READ_LIMIT = 100`), and the same pattern applies.
- **Default-deny schema.** A field is returned only if it is in the allowlist. A new field fails the tests until someone adds it.

## 4. What must never leave the device
These apply to every surface and every tier. None of them is configurable.

1. Raw events (L0) and full §5.4 event records.
2. Field values and `data_ref` contents. They fill approved automations and are never mined (§5.4), so they are never exported, including in run logs and error messages.
3. Screenshots, OCR output and window contents. OCR output is redacted and discarded (§5.3). Window titles and document titles are not returned.
4. Full URLs: path, query, fragment and userinfo. Private and incognito URLs are not stored (§5.3).
5. Anything from secure fields, password managers, banking, health, HR portals, personal messaging or incognito windows (privacy-legal §4 default exclusions).
6. Browsing that reveals a sensitive category, such as health, union, religious or political sites (privacy-legal §1, Art. 9 via C-252/21). Excluded by default.
7. Third-party identifiers: colleagues' and customers' names, email addresses, phone numbers and account numbers (privacy-legal §1). Run the deterministic pass, then NER, on every string before it is returned.
8. Keys and secrets: the database key, the pseudonymisation device secret, OAuth tokens and connector credentials (held in the OS keychain, automation-autonomy.md), and the MCP client tokens.
9. The pseudonym map, and any link to SSO, billing or licence identity (§3; privacy-legal: keep these out of the analytics path).
10. Emotion, focus, engagement, stress, idle-time, keystroke-count or per-person productivity values.
11. Any employer-facing data. MCP has no admin or company endpoint, and results never go to a company server.
12. Abstract cloud-escalation payloads (§6.3). They are built only on the path that §15a disables.

## 5. Threats and mitigations

| Risk | Mitigation | Honest limit |
|---|---|---|
| A client forwards results to a hosted model, breaking §15a | No third-party client in v1. Any later allowlist covers only clients the owner has verified as running open-weight models locally, and the consent screen shows the client by name. | companyOS cannot see what a client does after it receives a response. The ledger records what was sent, not what the client did with it. |
| Re-identification from combinations (a rare app together with a URL template) | Category-level domains by default. Suppress any combination below a rarity threshold N within the export window. | A single person's export is never anonymous (§3). N is a design choice, not a sourced figure. The employer rule (k ≥ 10) does not transfer directly. |
| Prompt injection through data: window titles, labels, URL templates and automation names come from the web and from other people | Use closed vocabularies where possible (action tokens come from a fixed list). Cap free text in length, strip control characters, and return strings in a field marked as data. | The client's model may still follow injected text. The server can limit what that text can cause. It cannot make the model safe. |
| Linkage across exports through stable IDs | Per-export random IDs (section 3.2). | None significant. |
| A local process or web page reaches the server | Use stdio, which the client spawns. If an HTTP transport is ever used, bind to loopback only, check Host and Origin headers against DNS rebinding, and require a per-client token held in the OS keychain. | Local malware running with the user's rights can read the store anyway. |
| A new tool or field leaks by accident | A default-deny schema in one module, a canary test per field, and CI failure on unknown fields. | Depends on review discipline. |
| A caller uses MCP sampling or roots to get model work or file access | Do not adopt Sampling, which would send twin data to whatever model the client runs. Do not adopt Roots, which is deprecated; use the explicit field allowlist. Logging is also deprecated. | None. |
| A caller triggers an external effect | The policy engine decides, and approvals are native and cannot be answered by the caller (D11). Tool annotations are not trusted. | Depends on the policy rules being right (§7.4). |
| Legal hold or a regulatory demand for an exported copy | The ledger lets the owner see every export. | Not resolved here. See open question 6. |

## 6. Controls required before any twin-data read ships
1. **Consent per client.** Shown once, with the tier and field list. Revocable from the tray. Visible in the app at all times.
2. **Preview.** The owner sees a sample of the exact response before the first export to each client, and again whenever the field schema changes. This is the §3 cloud-call preview, applied here.
3. **Ledger.** Every MCP call adds an on-device entry: time, client, tool, tier, record count and field names. It never stores values. These entries belong in the network ledger (§15a). The OpenMausBot handoff should be recorded there too, which §16 says it is not today.
4. **Redaction on the way out.** Run the redaction passes (deterministic first, then NER; privacy-legal §4) on every outgoing string. Redaction at ingest alone is not enough, because labels and titles can change after capture.
5. **Leak tests.** Add MCP responses as an output surface in the privacy suite. The branch origin/twin/privacy-canaries has the pattern: tests/privacy/surfaces.ts collects output surfaces, and tests/privacy/canaries.ts plants canaries on ingest surfaces. Plant canaries for window titles, document titles, URL query, fragment, userinfo, path segments and private-window URLs. None may appear in any MCP response. That branch is not merged, so its patterns must reach main first.
6. **Kill switch.** The owner stops the server in one action. Admins may disable it remotely (§8.1) and may never enable it.

## 7. Phasing
- **Now:** this proposal and the decisions in section 9. No code.
- **Phase 2 (per §10):** the automation surface, with read-only tools first (`list_automations`, `get_run_status`). `run_automation` only after execution tiers beyond app focus exist (§16) and the native confirmation path is built.
- **Twin-data reads:** not in the roadmap. They need a plan change first, then the controls in section 6. Keep them out of company mode entirely. Company output stays on the DAP path (§8.2).
- **Phase 1 exit:** the roadmap requires zero raw-content egress in the privacy tests. MCP responses must be in that suite before any MCP surface ships, in any phase.

## 8. Test plan (for the build, later)
- **Schema:** every returned field is in the allowlist. Unknown fields are dropped, and the drop is logged without values.
- **Canaries:** as in section 6, item 5, across every tier.
- **Pattern check:** no string in any response matches the secret rules, Luhn-valid card numbers, IBANs (mod-97), or email or phone patterns.
- **Ledger:** one entry per call, and no value, path, query or fragment in any entry.
- **Injection fixtures:** window titles and labels that contain instructions. Verify that the server returns them as marked data and that tool behaviour does not change.
- **Limits:** response size caps and pagination are enforced. An export does not exceed the §5.5 CPU budget while the app is busy.
- **Consent and kill switch:** calls fail closed when consent is missing or has been revoked.

## 9. Open questions for the product owner
1. **Scope.** Ship the MCP automation surface first, and hold twin-data reads until the plan changes? Recommendation: yes.
2. **Clients.** Allow any third-party client, only verified local open-model clients, or none in v1? Recommendation: none in v1, revisited with the §15a review.
3. **Domain detail.** Category-level or host-level domains by default? Recommendation: category.
4. **Rarity threshold N** for a single-person export. It needs a number and a rationale.
5. **Scope of owner export.** Is MCP export needed, given the JSON export in privacy-legal §4? Which path comes first?
6. **Legal review.** Does an owner export to a third-party client change the controller analysis? How does it interact with legal hold (§13, question 7)? Counsel should review before any twin-data read ships.
7. **Ledger scope.** Should MCP calls and the OpenMausBot handoff both appear in the network ledger? Recommendation: yes for both.

## 10. Unverified
- The MCP spec details (the revision named in §7.2, transports and auth) come from automation-autonomy.md. They were not checked against the spec in this proposal.
- Which real MCP clients forward results to hosted models is client-specific. No client was checked.
- The rarity threshold N is a design choice, not a sourced standard.
- The privacy canary suite is on origin/twin/privacy-canaries and is not merged into origin/main. Its patterns are cited here, not verified on main.
- The statement that the OpenMausBot handoff is not ledgered is taken from §16 and was not checked against the code paths.

## Sources
- docs/plan/README.md: §1, §2 (D2, D10, D11, D14), §3, §5.3, §5.4, §6.3, §6.4, §7.2, §7.4, §8.1, §8.2, §8.4, §10 (Phases 1 and 2), §13 (question 7), §15a, §16
- docs/research/privacy-legal.md: §0, §1, §4, §5
- docs/research/automation-autonomy.md: MCP tier, credential handling, tool annotations
- docs/research/prior-art.md: export automations as MCP tools
- packages/core/src/redact.ts, handoff.ts and policy.ts (origin/main)
- origin/twin/privacy-canaries: tests/privacy/canaries.ts and tests/privacy/surfaces.ts
