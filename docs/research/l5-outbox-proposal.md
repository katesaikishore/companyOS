# Level 5 outbox: proposal

Status: proposal only. No code. Written 2026-10-31 against `origin/main` (0b95130). Update: the OpenMausBot handoff named below was removed from the product the same day (plan D15), so those references are historical.

Sources: `docs/plan/README.md` §2 (D11), §7.1–§7.5, §10 (Phase 2 and Phase 4), §13, §14, §16. `docs/research/automation-autonomy.md` §3 (autonomy levels), §4 (outbox and kill switch), §7 (v2). Code: `packages/core/src/policy.ts`, `packages/core/src/types.ts`, `packages/core/src/runner.ts`, `apps/desktop/src/main/index.ts`.

## 1. Summary

A Level 5 outbox is a queue that holds every outward-facing action (a message sent, a record written to a third-party system) for a short countdown before it runs. During the countdown the owner can preview the exact content and cancel it. Where policy requires, the owner must also approve it first. The plan names the delay and the approval gate as the only mitigation for effects that cannot be undone (§7.3).

Recommendations:

- **Do not build it now.** L5 is v2 only (plan §7.3, §10 Phase 4). The code already denies level 5 (`policy.ts`: "Fully autonomous external actions are not part of this version").
- **When it is built, start narrow:** one effect class, known recipients only, fixed templates only, an owner opt-in per automation, and no unattended sends until the countdown has shown it works as a veto.
- **Two findings change the design.** (a) A 30–60 second countdown protects only when a person is present to see it, so unattended sends need a different rule (section 6). (b) The Rule of Two (plan §7.4) forbids a session that reads untrusted content from also holding external-communication capability. That rules out free-text replies drafted from incoming messages (section 7).

## 2. What the plan already requires

- **L5** is "Autonomous, external: sends, writes to third-party systems", available in v2 only (§7.3).
- **Outbox delay.** External effects wait 30–60 seconds in an outbox the owner can cancel. Irreversible effects cannot be undone, so the delay and the approval gate are the only mitigation (§7.3). The 30–60 second range is a design recommendation, not a sourced standard (§14).
- **Hard floor** (§7.4). External messages to new recipients always need approval, at every level. So do money, deletion, credential or permission changes, and installs.
- **Rule of Two** (§7.4). An agent step that reads untrusted content may not also hold external-communication capability in the same session.
- **Injection** (§7.5). Prompt injection cannot be fully prevented. The mitigations are fixed control flow, the policy floor and the Rule of Two. The design target is a small blast radius, not detection.
- **Promotion gate** (§7.3). The plan gives one gate, for L3 to L4: at least 10 supervised runs, at least 25 runs over 14 days, at least 99% postcondition pass rate, and zero owner corrections or reverts in the window. **The plan has no gate for L4 to L5.** The research doc proposes at least 25 runs over at least 14 days (`automation-autonomy.md` §3). The plan should be amended before L5 is built.
- **Demotion** (§7.3). Any failed postcondition, or any owner revert, drops the automation to L3.

## 3. Current state in the code

- `types.ts` defines seven effect classes: `read_only`, `local_reversible`, `external_effect`, `money`, `deletion`, `permission`, `install`. `FLOOR_EFFECTS` lists the last five. Those need a present person at every level.
- `policy.ts` denies level 5 outright. At level 4 and below, floor effects ask the person when present and are denied when unattended.
- The MVP steps are `focus_app`, `check_focus`, `open_url`, `open_file` and `press_shortcut`. None sends or writes to a third party, so there is nothing to queue yet.
- There is no outbox, countdown, preview queue, idempotency key or Rule of Two check in the code. Policy is ordinary TypeScript. The plan (§7.4) specifies Cedar or OPA.
- A stop-all hotkey and a tray item exist (`apps/desktop/src/main/index.ts`). The runner reads the stop flag before each step (`runner.ts`).
- The OpenMausBot handoff (plan §16) sends a brief outside companyOS and is not covered by the autonomy controls. The outbox must not accept entries from it.

## 4. Model

### 4.1 Queue item

Each item records (conceptually, not as a schema):

- item id, automation id and version, run id, step id;
- effect class and reversibility (reversible, compensatable or irreversible);
- target system and recipients, each marked new or known;
- the payload: the exact content, stored as a content hash plus the rendered copy, and attachments by hash;
- the policy decision and the policy version at queue time;
- `created_at`, `send_at` (approval time or queue time, plus the countdown), and approval state;
- an idempotency key, where the target supports one;
- state, outcome and any read-back result.

### 4.2 States

```
queued --(approval, if required)--> queued, approved --(countdown ends)--> sending --> sent
   |                                                                          |
   +--> cancelled (owner)     +--> blocked (kill switch or policy change)     +--> failed
   +--> expired (approval not given in time)                                   +--> unknown
```

Rules:

- Only an approved item whose countdown has ended may enter `sending`.
- The item records its intent before the external call, so a crash leaves a visible record.
- On restart, an item found in `sending` without an outcome becomes `unknown`. It is never retried automatically, because a retry can duplicate a message. The owner decides.
- Cancel is accepted only in `queued`. Once `sending` starts, the outbox shows "cannot be cancelled" and records the result.
- The kill switch cancels every queued item and blocks new ones. Calls already in flight cannot be recalled, and they are reported.

### 4.3 Countdown

- Proposed default 30 seconds, owner-adjustable up to 60 seconds, as the plan gives the range. Longer gives more chance to veto. Shorter keeps unattended runs useful.
- Where approval is required, the countdown starts at approval. The owner gets a second look after approving.
- No "send now" control at L5. It would remove the only veto.

### 4.4 Preview

The preview must show exactly what will be sent:

- recipients, each marked new or known, with last-contact date from the twin's own history;
- the full text as plain text, with no hidden HTML;
- attachments by name, size and hash;
- for writes, the target system and the before and after values;
- the effect class and a label: "cannot be undone after sending" where it applies;
- the automation name and version, and the policy reason that queued it.

The send uses the bytes whose hash the preview showed. If the hash differs at send time, the item is blocked, not sent.

### 4.5 Cancel and approval

- **Cancel** is one action from the outbox view, the notification and the tray or menu item. Cancelled items stay in the audit log.
- **Approval** comes only from a present person. It is bound to the item's hash, so it cannot be reused for a changed payload. An automation or an agent step cannot approve.

## 5. Which effects may enter the outbox

| Effect | Queue at L5? | Approval | Countdown | Notes |
|---|---|---|---|---|
| `read_only` | No | None | None | Not outward-facing |
| `local_reversible` | No | None | None | L4 path |
| `external_effect`: message to a known recipient, fixed template | Yes, proposed | None, unless the owner sets one | Yes | First candidate for v2 |
| `external_effect`: message to a new recipient | Yes, with approval | Each time | Yes, after approval | Plan §7.4 floor |
| `external_effect`: public posting | Yes, with approval | Each time | Yes, after approval | Research §3 floor |
| `external_effect`: write to a third-party system | Yes, proposed | Owner's choice per target | Yes | Needs a read-back check and a compensating action where one exists |
| `money` | No | Always a present person | n/a | Plan §7.4. Not queueable |
| `deletion` | No | Always | n/a | Files go to trash (§7.5) |
| `permission` | No | Always | n/a | Plan §7.4 |
| `install` | No | Always | n/a | Plan §7.4 |

Two more rules:

- A vision-tier step (plan §7.2, tier 5) may not enter the outbox. Its target is not reliably identified, and it is a fallback that needs human confirmation at MVP.
- Only an `act` step with a typed payload may enter the outbox. No step may send free text that an agent step produced from untrusted content (section 7).

## 6. The unattended problem

The countdown is a veto only if someone sees it. An L5 automation that runs overnight queues a message, and nobody is there to cancel it. The countdown then protects nothing, and the real check is what happens afterwards.

Proposed rule:

- An unattended run may queue only known-recipient messages from fixed templates, within the rate and daily caps.
- Anything that needs approval waits for a present person and expires if it is not approved within a window the owner sets.
- Every unattended send produces a digest notification afterwards. The digest, not the countdown, is the check for unattended runs.
- The owner can switch off unattended sends while keeping attended sends on.

## 7. Rule of Two and drafting

Replies drafted from incoming email, chat or web pages read untrusted content. Under plan §7.4 they cannot hold external-communication capability in the same session. Three options:

- **A. Fixed templates only (proposed).** Message content is compiled. The only inputs are typed values, such as a date chosen from a parsed list or a name from a known contact list. Free text from untrusted sources is never sent. This satisfies the Rule of Two by construction.
- **B. Two sessions.** A reading session produces typed output only, and a separate sending session holds the capability. This is still a Rule of Two split. It needs an enforced boundary in code, not a prompt.
- **C. Free-text drafting from untrusted content.** Not allowed at L5. It can be offered at L2, as a draft that is not queued.

The typed output of an `agent_step` (plan §7.1) must never contain free text that the outbox sends.

## 8. Gates before it ships

Each gate needs evidence, not only a plan.

1. **Phase 2 exit met.** L4 has run on real automations, the promotion gate has been exercised, and there have been zero unapproved external effects (§10). Evidence: beta records.
2. **L4 to L5 promotion gate written into the plan** (section 2). Evidence: amended §7.3.
3. **Policy engine decided.** Cedar or OPA, as §7.4 specifies, or the current TypeScript. Evidence: a recorded decision, and tests that cover every floor effect at level 5.
4. **Rule of Two enforced in code.** Evidence: a test that a session with untrusted input cannot queue an external effect.
5. **Persisted outbox state machine,** with the restart behaviour in section 4.2. Evidence: tests for a crash during `sending`, and a test that nothing retries automatically.
6. **Payload hash check.** Preview and send use the same bytes. Evidence: a test that a modified payload is blocked.
7. **Idempotency and read-back.** Each external write has an idempotency key where the target supports one and a read-back postcondition (§7.5). A target without either is not eligible for L5. Evidence: per-target tests.
8. **Kill switch covers the outbox.** It cancels queued items, blocks new ones, and reports in-flight calls. Evidence: a test with queued items, and a measured latency.
9. **Rate limits** per automation, per recipient and per target, plus daily caps (§7.5). Evidence: tests.
10. **Redaction and egress.** Queued payloads pass the same privacy checks as other egress. The privacy canary tests cover outbox payloads (§5.3, Phase 1 exit). Evidence: passing canary tests.
11. **Audit log.** Every queue, cancel, approval, send and failure is recorded, redacted and tamper-evident (§7.5). The plan says encrypted and redacted; the research doc says hash-chained (`automation-autonomy.md` §4). The owner picks the combination.
12. **Injection tests on the drafting path.** Fixtures in which screen or web text tries to add a recipient, change a template or shorten the countdown must all be blocked. Measure blast radius, not detection rate (§7.5).
13. **Countdown evidence.** The 30–60 second range is a recommendation (§14). A supervised pilot should measure how often owners see the countdown and cancel, and how often a notification is missed.
14. **Legal review.** Covers messages sent by an agent on a person's behalf, recipient consent and disclosure, and in company mode the employer and works-council context (§8, §12).
15. **OpenMausBot handoff excluded** from the outbox unless it passes the same gates (§16).
16. **Demotion implemented.** A failed postcondition, an owner revert or an `unknown` send drops the automation to L3 (§7.3).

## 9. Metrics to watch

- Cancel rate per automation. A high rate means the automation should drop a level.
- Count of `unknown` sends. It should be zero.
- Count of hash mismatches blocked at send. In normal use it should be zero. Any non-zero count is a bug.
- Time from queue to send, against the countdown.
- Reverts of unattended digests by the owner.

## 10. Test plan, for when it is built

- State machine tests for every transition, including a crash during `sending`.
- A property test that only the previewed bytes are sent.
- Policy tests: each floor effect at each level, and the level 5 path for each allowed effect.
- Injection fixtures from gate 12.
- A kill-switch test with queued items.
- A canary test over outbox payloads.
- A pilot: supervised sends first, then unattended sends to known recipients only.

## 11. Decisions for the owner

1. **Build the outbox in v2 at all.** This proposal does not change §10 Phase 4.
2. **Countdown.** Default and allowed range. Proposal: default 30 seconds, owner may raise to 60 seconds, no "send now" at L5.
3. **Unattended sends.** Proposal: known-recipient, fixed-template sends only, with a digest.
4. **Approval window.** How long an item waits for approval before it expires. Proposal: a window the owner sets, with 24 hours as the starting value.
5. **Money.** Proposal: never queueable.
6. **Cancels and promotion.** Proposal: a cancel counts as an owner correction for the promotion gate. It does not by itself demote.
7. **Rule of Two approach.** Option A (fixed templates only) or option B (two sessions).
8. **Policy engine.** Cedar, OPA, or the current TypeScript.
9. **L4 to L5 promotion numbers.** The plan has none. The research doc proposes 25 runs over at least 14 days.
10. **Legal review.** Scope, and who orders it.

## 12. What this does not decide

- L0 to L4 behaviour. Nothing here changes it.
- Any vision-tier action at L5. Section 5 keeps it out of the outbox.
