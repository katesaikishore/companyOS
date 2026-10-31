# Research track: company server proposal

## Company server for phase 3 (proposal, no code)

As of 31 Oct 2026.

**Status:** proposal only. Nothing here is built, and no code, schema or test changes are proposed. The company parameters stay pending legal review (plan 8.2).

**Base:** `origin/twin/company-core` at `74ed888` ("Start phase 3: company aggregates, not wired to any pilot"). That commit is already an ancestor of `origin/main`, and `docs/plan/README.md` is identical on both, so the plan sections cited here are current. No other `origin/twin/*` branch touches company mode; the nearest work is `sqlcipher-store` (the device store), which this proposal depends on but does not change.

**Verified on this base:** `vitest run` in `packages/core` gives 9 test files and 126 tests, all passing. `test/company.test.ts` contributes 12 of them.

## 0. Summary

- Phase 3 needs a company server that receives only differentially private (DP) aggregates, built on secure aggregation, with a minimum cohort of 10 (plan 8.2, 4, 10).
- `packages/core/src/company` already has the release math: parameters, per-device clamping, Laplace noise, the cohort threshold, a privacy budget and a strict release schema. It has no server, no transport, no device sender, no durable state, and nothing reads its output.
- Three parts of that code conflict with the phase 3 design and must change before a server is built: `releaseCohorts` takes each device's plaintext contributions; `PrivacyBudget` is held in memory, so a restart resets the spend; and the threshold step gives an approximate guarantee with no derived delta.
- Proposed shape: a two-operator DAP setup (leader and helper, assumed not to collude) with Prio3 over a fixed item dictionary; a release service that reuses the company module on aggregated inputs only; a durable budget ledger; device enrolment through MDM; and a read-only admin API. Use an existing DAP implementation after a spike, and do not write one.
- The decisions in section 7 belong to the product owner and counsel. This proposal does not make them.

## 1. What company-core covers

| File | What it does | Tested by |
|---|---|---|
| `packages/core/src/company/params.ts` | `COMPANY_PARAMETERS`: `cohortMin` 10, `epsilonPerRelease` 1, `maxItemsPerDevice` 5, `maxCountPerItem` 20, `budgetTotal` 10. Status is "pending legal review (plan 8.2)". | Values are asserted through the release tests. |
| `packages/core/src/company/noise.ts` | `systemUniform` draws from `node:crypto`, with 53 bits and values strictly inside (0, 1). `laplace` uses the inverse CDF. The file calls the sampler a reference and names OpenDP for production. | Scale check over 40,000 draws, and a range check over 20,000 system draws. |
| `packages/core/src/company/release.ts` | `ContributionSchema` and `CohortReleaseSchema` (both strict, neither has a device field). `PrivacyBudget`. `releaseScales` gives a count scale of 10 and a total scale of 200 (sensitivity over epsilon 0.5). `clampDevice`. `releaseCohorts`, which publishes an item only when its noisy device count reaches 10, then adds noisy totals. The budget is charged before any noise is drawn. | 12 tests: threshold, per-device caps, refusal with no noise drawn when the budget is spent, no negative totals, refusal of extra fields and negative or fractional counts, and the release shape. |

The code states its own limits. The guarantee is approximate, and the delta is not derived. The sampler is a reference. Secure aggregation is not built. The `company/index.ts` export is the only consumer outside the tests.

**Not on the branch:** any server or HTTP surface; a device-side sender; DAP or Prio3; OpenDP; durable storage of the budget or of releases; device enrolment or authentication; an admin API; the employee preview required by plan 8.2; network ledger entries for company traffic; MDM packaging; the compliance pack (plan 8.3); and deployment (plan 8.5).

## 2. Conflicts in the base code

### 2.1 The release function sees plaintext per-device data

`releaseCohorts(devices: ReadonlyArray<readonly Contribution[]>, ...)` loops over each device's contributions in the clear. Plan section 4 says the company path is "DP aggregates, k ≥ 10, secure aggregation". Plan section 10 requires "a pilot with no per-person data leaving the device". If the server runs this function as written, the aggregating party sees each device's counts.

Required change: the release step takes per-item sums and per-item device counts produced by the protocol. Per-device clamping moves to the device and is enforced by the protocol (see 2.3), not by trusting the client. The threshold and noise logic can stay as it is.

### 2.2 Secure aggregation needs a fixed item dictionary

`ContributionSchema` accepts any string up to 200 characters. A Prio3 measurement has a fixed type and length that is set when the task is created. The secure path therefore needs a published, versioned item dictionary for each release. Items outside it are either dropped or sent to an "other" bucket. That choice changes what the company can see, so the owner must decide it (section 7). The dictionary must hold app and workflow names only, never anything that describes a person's performance (plan 8.4).

### 2.3 The per-device bounds must be enforced by the protocol

The clamp (at most 5 items, each at most 20) is the sensitivity bound behind `releaseScales`. If a device can submit 1,000 for one item, the noise is calibrated too low and the guarantee fails. The validity check on each report must enforce both bounds. Whether a Prio3 validity circuit can express "at most five non-zero entries, each at most 20" has not been verified here. A cryptographer must confirm it before the design is fixed. If it cannot, the bounds must be enforced some other way, and the scales in `releaseScales` change with them.

### 2.4 The privacy budget is held in memory

`PrivacyBudget` keeps `spent` as a plain field. A restart resets it to zero, and the server would then release more than `budgetTotal` allows. The server needs:

- an append-only, durable spend ledger;
- check and spend in one atomic step, before any noise is drawn or any output is written;
- one ledger record per release (time, epsilon spent, parameter version, item count);
- a defined period and reset rule. `budgetTotal` is described as "for one period", but no period is defined anywhere;
- admin visibility of spend, and no admin action that resets it without an audit entry.

Keep the existing rule that a release that fails part way is still charged.

### 2.5 The threshold step is not pure DP

Publishing an item by thresholding its noisy device count gives an approximate guarantee with an undetermined delta. Plan 8.2 says the budget and retention are "design recommendations and need legal review". Two options:

- (a) keep the threshold, and have a statistician derive and state a delta that counsel accepts;
- (b) use a mechanism whose guarantee is derived in OpenDP, and keep k ≥ 10 as a policy floor on top.

Recommendation: (b), unless a statistician can derive the delta for (a) before the pilot.

### 2.6 Device count can be faked

The k ≥ 10 rule counts devices. If anyone can create devices, one person can pass the threshold and multiply their own contribution. Reports should be accepted only from devices enrolled through company MDM, each with a per-device credential that is issued at enrolment and can be revoked. The admin sees the enrolled count, never a mapping from people to items.

The credential proves a report came from an enrolled device, so it must not let the aggregator link reports across epochs. The research track's rotating pseudonymous IDs (`docs/research/privacy-legal.md`, the "Org aggregates" item) are the starting point. How to do that (per-epoch tokens, for example) needs a design review.

### 2.7 Central DP means the release service sees exact aggregates

Plan 8.2 and the research track both assume DP is added centrally, after aggregation. The release service therefore sees the exact, unnoised aggregates before it adds noise. The guarantee holds only against parties who see the noised release. So the operator of the release service must be a party the design trusts, and this must be stated to employees (section 7).

### 2.8 Wording in plan section 4

The diagram in plan section 4 shows `twin-agent ──DP aggregates──► org dashboard`. Under this design the device sends encrypted shares of bounded counts, and noise is added after aggregation. The wording should say so. The plan itself is not changed by this proposal.

### 2.9 The Laplace sampler

`noise.ts` says the sampler is a reference and that floating-point Laplace samplers have known weaknesses. The tests check its scale, not its security. Production noise must come from OpenDP, as plan 8.2 states.

## 3. Proposed server design

### 3.1 Components

| Component | Where it runs | Job | What it sees |
|---|---|---|---|
| Device sender (in the twin-agent or desktop app, company mode only) | Employee device | Builds one bounded fixed-vector report per epoch. Shows the employee the exact report first (plan 8.2 preview). Encrypts a share to each aggregator. | Its own report only |
| Leader aggregator (DAP) | Operator to be decided (section 7) | Receives reports, checks validity, sums shares | Encrypted shares, then aggregate shares |
| Helper aggregator (DAP) | A second operator, not the leader's | Receives the other share of each report, sums it | Encrypted shares, then aggregate shares |
| Release service (collector) | Operator to be decided (section 7) | Collects aggregate results, checks budget in the ledger, applies threshold and noise, builds the release record | Exact aggregates, before noise (see 2.7) |
| Admin read API | Same service as the release service | Returns `CohortReleaseSchema` objects only | Releases only |
| Enrolment service | Integrated with MDM | Issues and revokes device credentials | Device identity, never content |

### 3.2 Release flow

1. The owner approves parameters and the item dictionary, and both are recorded with the release version.
2. Enrolled devices send one report per epoch. The epoch length is open (section 7).
3. The leader and helper validate and aggregate. The release service collects the aggregate results.
4. The release service spends from the durable ledger. If the spend is refused, it stops and writes nothing.
5. The release service applies the threshold and the OpenDP-backed noise, builds a `CohortRelease`, and parses it against the strict schema.
6. The release is stored and shown to admins. It names items and noisy totals only.

### 3.3 Stack

- **Release service and admin API:** TypeScript on Node 22 or later, which matches the root `engines` field. It reuses `packages/core/src/company` after the change in 2.1, so the release math stays in one codebase.
- **DAP leader and helper:** use an existing DAP implementation and do not write one. The research track names Janus (Rust) and Divvi Up. Divvi Up is a hosted service, so it would send data to a third party. That conflicts with the "Cloud: None" row in plan section 9, so this proposal does not use it. These implementation details come from the research track and were not checked here, since this run makes no external calls.
- **Noise:** OpenDP, as plan 8.2 names. The language binding is chosen in the spike.
- **Storage:** a transactional database for the budget ledger and releases. The device side already uses an encrypted SQLite store (plan section 4). The server store is chosen in the spike, but it needs atomic check-and-spend.
- **Deployment:** a container image built and signed in CI, run by the operator. Logs carry counts and identifiers of releases, never item-level or device-level content.

## 4. Fit with the plan

- **Plan 8.1 (admins cannot read per-person data):** the admin API returns releases only. The enrolment service knows device identity but not content. No endpoint takes a device identifier together with an item. This needs API tests, as well as the schema tests that already exist.
- **Plan 8.2 (employee preview):** the preview is produced on the device, from the exact report before encryption.
- **Plan 8.3 (compliance pack):** these are documents, not code. The DPIA, works agreement and notices block the pilot (section 8).
- **Plan 8.4 (AI Act positioning):** the item dictionary must exclude anything that describes a person's performance.
- **Plan 8.5 (deployment):** MDM controls updates in company mode. The server has its own release cadence.
- **Plan section 9 and 15a:** the "Cloud" row reads "None (§15a)". A company server is a new network destination. §15a is about models, so it does not settle this. The owner must amend §9 and §15a, or add a decision, before phase 3 starts.
- **Network ledger:** `NetworkEntry.purpose` is currently `'model_download'` only (`packages/core/src/models/types.ts`). Company uploads need their own purpose, and the ledger must show them. Otherwise the "what left my device" promise breaks.
- **README:** the line "companyOS sends nothing to an employer. The source has no employer endpoint" becomes false when company uploads ship. The README and the ledger text must change in the same change set.
- **Phase 3 exit wording:** "a pilot with no per-person data leaving the device" holds only if reports are read as encrypted shares that no single operator can decrypt. The owner should choose the exit wording. This proposal does not change the plan's text.

## 5. Phased sequence (sequencing only, no schedule)

- **S0, human decisions:** legal and statistical sign-off on the parameters and on the threshold option (2.5). Choice of the two operators, the release-service operator and the hosting region. Confirmation of the non-collusion assumption.
- **S1, core change:** reshape `releaseCohorts` to take aggregate inputs, keeping the clamp and threshold logic. Add a durable budget ledger interface with a restart test.
- **S2, spike:** Prio3 on the fixed dictionary, with a validity check that enforces both bounds (2.3). Confirm the chosen leader and helper implementation. Measure cost per device per epoch. Pass criteria: a report that breaks a bound is rejected in a test, and the aggregate matches the clear-text sums in tests.
- **S3, device side:** enrolment, per-epoch credentials, and the report preview.
- **S4, server side:** release service, admin read API, network ledger purpose, and README and ledger text.
- **S5, pilot prerequisites:** DPIA, works agreement and notices (plan 8.3), and packaging (plan 8.5). These are human-owned.

Tests to add when the work starts: a release never contains a device identifier; the budget survives a restart, and a spend is refused after one; a refused release writes nothing to the ledger; and a report that breaks a bound is rejected.

## 6. Out of scope

- Any code, schema or test change. `packages/core` is not touched by this proposal.
- Legal conclusions. The research track holds them.
- Any delegation path. The OpenMausBot handoff was removed on 2026-10-31 (plan D15), so it is no longer a path to exclude.
- The contents of the item dictionary.

## 7. Decisions needed from the owner

1. **The two aggregators:** who operates each, and whether employees are told that DAP assumes they do not collude.
2. **The release service:** who operates it. It sees exact aggregates before noise (2.7).
3. **Hosting region:** and whether any hosted DAP service is acceptable, given plan section 9 and §15a.
4. **Threshold mechanism:** option (a) or (b) from 2.5, and who states the delta.
5. **Budget period, reset rule, and who may read the spend.**
6. **Item dictionary:** its contents, its owner, and how apps not on it are handled.
7. **Epoch length.**
8. **Phase 3 exit wording** (section 4).
9. **Whether any per-device data in the clear ever reaches the server.** This proposal assumes it never does.

## 8. Blockers outside this sandbox

- Legal review of the parameters (plan 8.2; `COMPANY_PARAMETERS.status`).
- Statistical sign-off on the mechanism and the delta.
- Cryptographer review of whether a validity check can express both bounds (2.3).
- DPIA, works agreement and notices (plan 8.3). These are human actions and cannot be done in code.
