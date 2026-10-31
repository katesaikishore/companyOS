# Spike S1: do TCC grants survive an update for an embedded SMAppService helper?

**Status:** Checklist ready, 2026-10-31. The run has not happened. It needs a physical Mac, Developer ID signing and notarization (section 10).
**Sources:** [`README.md`](README.md) §5.1 to §5.3 (capture and permissions), §8.5 (deployment), §10 Phase 0 (S1), §12 (risk "TCC attribution breaks on updates"), §13 and §14 (open questions and the unverified SMAppService item). Research: [`../research/os-capture.md`](../research/os-capture.md), the TCC and update notes.

## 1. Question, pass bar and scope

- **Question (§10, S1):** does a helper embedded in the main app bundle and registered with `SMAppService` keep its Accessibility and Input Monitoring grants after the app is updated?
- **Pass bar (§10):** the grant survives an update, tested on a real notarized build.
- **Why it matters:** capture (§5.1) needs both grants. If they reset on update, capture stops silently (§12). If S1 fails, the fallback is to run capture in the main app process, as D5 already sets for the MVP. That is an owner decision (§13).
- **In scope:** Accessibility (AX) and Input Monitoring (listen-only event tap), the two MVP permissions in §5.2.
- **Recorded, not gating:** Screen Recording. It is opt-in and its re-approval prompts recur regardless of updates (§5.2, §14).
- **Out of scope:** MDM PPPC pre-grant (§14), macOS consent UX (§5.2), and spikes S2 to S7.

## 2. Identity lock (decide before building)

Choose these once and do not change them in any build in this run. The plan says a change to any of them silently resets grants (§4, §12). Changing them is the negative control (section 6), not a test build.

| Item | Value for this run |
|---|---|
| Main app bundle ID | `<APP_ID>` |
| Helper bundle ID | `<HELPER_ID>` |
| Apple Developer Team ID | `<TEAM_ID>` |
| Helper location | `<App>.app/Contents/Library/LoginItems/<Helper>.app` |
| Signing identity | Developer ID Application: `<name>` |
| Designated requirement, app | copied from build v1 with `codesign -d -r-` |
| Designated requirement, helper | copied from build v1 with `codesign -d -r-` |

## 3. Build steps

### 3.1 Prerequisites

- [ ] A physical Mac on the current macOS major and a second Mac on the previous major. §9.2 uses the latest and n-1 in its CI matrix. Record model, chip, `sw_vers` and `xcodebuild -version`.
- [ ] Apple Developer Program membership with a Developer ID Application certificate and a Developer ID Installer certificate (the `.pkg` channel, §8.5).
- [ ] A notarization keychain profile, made with `xcrun notarytool store-credentials <profile>`. No Apple ID, app-specific password or key goes in the repo or in the evidence.
- [ ] A dedicated macOS test account with no personal data. The harness logs only booleans and error codes (section 4), but a clean account is still required (§5.3, D7).

### 3.2 Spike code (not shipped)

- [ ] Put the spike under `spikes/tcc-s1/`, on its own branch. It is not part of the product build.
- [ ] Main app: a minimal app that shows `CFBundleShortVersionString` and `CFBundleVersion`, and has a button that registers the helper.
- [ ] Helper: a minimal background app with no UI and no capture code. It runs the checks in section 4 and appends one JSON line per run to a file in the test account's home directory.
- [ ] Register with `SMAppService.loginItem(identifier: "<HELPER_ID>")`. Expected `status` is `.enabled`. If it is `.requiresApproval`, approve the item in System Settings > General > Login Items & Extensions, then check again. Record the status value.
- [ ] Hardened runtime on both targets. No Apple Events entitlement and no other entitlement. The AX and Input Monitoring checks do not need one.

### 3.3 Build, sign and notarize v1

- [ ] Archive with manual signing: the Developer ID Application identity, `--options runtime` and a secure timestamp.
- [ ] `codesign --verify --deep --strict --verbose=2 "<App>.app"` passes.
- [ ] `codesign -dv --verbose=4` on the app and on the helper path shows the Team ID from section 2.
- [ ] Save `codesign -d -r-` output for the app and for the helper as text files. These are the designated requirements the spike must keep.
- [ ] Notarize each artifact the run installs. Channel A uses a `.zip` of the `.app`. Channel B uses a `.pkg`, built with `productbuild --component "<App>.app" /Applications --sign "<Installer identity>" v1.pkg`.
  - `xcrun notarytool submit <artifact> --keychain-profile <profile> --wait`. Save the submission ID and status.
  - Staple before zipping: `xcrun stapler staple "<App>.app"`. Staple the `.pkg` itself for channel B.
  - `xcrun stapler validate <artifact>` passes.
  - `spctl --assess --type execute --verbose=4 "<App>.app"` (or `--type install` for the `.pkg`) is accepted with source "Notarized Developer ID".

### 3.4 Build v2 and v3 (update builds)

- [ ] Same identity lock as section 2. Change only `CFBundleShortVersionString` and `CFBundleVersion`. The helper binary stays the same, except in cycle U4.
- [ ] Build and sign as v1. Compare the new `codesign -d -r-` output with v1's. The files must be identical. A difference makes the run INVALID (section 7). Fix the build and restart the run.
- [ ] Notarize and staple each build, as for v1.

## 4. Grant checks (run inside the helper)

Rules for every check:

- [ ] The helper runs through launchd, the login item, and not from Terminal or Xcode. A grant held by a shell or an IDE hides a reset. Check that `ps -o ppid= -p <helper pid>` prints `1`.
- [ ] Use only the no-prompt forms below. A prompt during a check is an event to record, and the check is then repeated.
- [ ] Wait up to 60 s after each launch before recording a failure. Record the time to first green.
- [ ] The Finder check below uses Finder's application element, which is always running. The focused app can be absent, so it is not used.

| Permission | Check (no prompt) | Expected value |
|---|---|---|
| Accessibility, trust | `AXIsProcessTrustedWithOptions` with `kAXTrustedCheckOptionPrompt` set to `false` | `true` |
| Accessibility, functional | `AXUIElementCopyAttributeValue` on `AXUIElementCreateApplication(<Finder pid>)`, attribute `kAXRoleAttribute` | error `0` (success). `-25211` means the API is disabled, i.e. not trusted. Record any other code. |
| Input Monitoring, trust | `IOHIDCheckAccess(kIOHIDRequestTypeListenEvent)` | `kIOHIDAccessTypeGranted` (0) |
| Input Monitoring, preflight | `CGPreflightListenEventAccess()` | `true` |
| Input Monitoring, functional | Create a `listenOnly` `CGEvent` tap, then disable and release it | tap is non-nil |
| Screen Recording (optional) | `CGPreflightScreenCaptureAccess()` | recorded only, not gating |
| Helper status | `SMAppService.loginItem(identifier:).status` | `.enabled` |

Each run appends one JSON line. It holds only the fields below. It must not hold field values, key contents, window titles or AX values (D7, §5.3).

```
{ts, app_version, helper_version, smappservice_status, helper_ppid,
 ax_trusted, ax_read_error, im_iohid, im_preflight, tap_created, sr_preflight}
```

**Baseline (before any update):** every required check is green on v1 for each channel, and the System Settings entries show the expected state. Save a screenshot of Privacy & Security for Accessibility and for Input Monitoring. Record which entry name appears. If the helper shows as its own entry rather than the app, record it as a finding about attribution. That alone is not a FAIL.

## 5. Update step

**Principle:** use the real update path, not a hand copy. Run both channels the plan names, so the result does not depend on which updater the product ends up with. Note the open point: §4 says Electron, and the research note says a Tauri updater. If the chosen updater installs in a third way, add it as channel C before the MVP commitment.

- **Channel A, self-update (personal mode):** replace `<App>.app` in `/Applications` with the new notarized build, the way the updater does.
- **Channel B, MDM push (company mode, §8.5):** `sudo installer -pkg <build>.pkg -target /`.

Each channel starts from a fresh v1 install with a clean grant state. Stale grants from an earlier run would hide a reset:

- [ ] `tccutil reset All <APP_ID>` and `tccutil reset All <HELPER_ID>` before each channel's baseline. Record the output.
- [ ] Grant AX and Input Monitoring by hand in System Settings, for the entry the baseline names.

### 5.1 Steps for each update cycle

- [ ] Confirm the baseline for the installed version: section 4 is all green and the helper status is `.enabled`.
- [ ] Quit the helper and the app. `pgrep -fl "<Helper>|<App>"` returns nothing.
- [ ] Install the new build through the channel. Record the exact command, start and end time, and exit code.
- [ ] Check `codesign -d -r-` on the installed copy, not the archive. It must match v1.
- [ ] Launch the app from Finder or with `open`, not from Terminal. Register the helper again only if the status is not `.enabled`, and record whether it was needed. Re-registration is acceptable only if it needs no TCC user action.
- [ ] Wait up to 60 s, then run the section 4 checks. Save the JSON lines and screenshots of both Privacy & Security panes.
- [ ] Confirm that no prompt appeared during the install, the launch or the checks. Screenshot any prompt.

### 5.2 Cycles

| Cycle | Change | Channel | Required |
|---|---|---|---|
| U1 | v1 to v2, version bump only | A | yes |
| U2 | v1 to v2, version bump only | B | yes |
| U3 | v2 to v3, version bump only. Then reboot, log in, and check at login without relaunching by hand. | A and B | yes |
| U4 | Helper binary changes only, same identity. Main app unchanged. | A | yes if the product ships helper-only updates. Otherwise optional. |
| U5 | Install while the helper is still running, with no quit first | A | optional, record |
| C1 | Negative control, section 6 | A | yes |

## 6. Negative control (required)

Without this control, a PASS may be a false pass. The grant could be held by another process, such as Terminal, or the harness could be unable to detect a reset.

- [ ] Build v2c with a changed **main app** bundle ID, `<APP_ID>.control`, and keep the same team. Build and notarize as in section 3.
- [ ] Install over v1 through channel A. Run section 4.
- [ ] **Expected:** the grant does not carry over. The checks fail until the operator grants it again. The helper is attributed to the app, so the app's identity is what matters. Changing only the helper's bundle ID may not reset anything, which is why the main app ID is the one changed.
- [ ] **If the grant carries over:** the control failed, so the run is INVALID (section 7).
- [ ] Optional, record only: C2, which changes only `<HELPER_ID>`. The plan does not say what it does.

## 7. Pass, fail and invalid

Write the verdict rules down before the run. Do not change them after seeing results.

**PASS (S1 confirmed for this build).** All of the following hold:

1. Baseline is green on v1 for both channels before any update.
2. The designated requirements, bundle IDs, Team ID and helper path are identical across v1, v2 and v3, checked on the installed copies.
3. U1, U2 and U3 (including after reboot) keep AX trusted, the AX read error at `0`, Input Monitoring granted and the tap created. All of this happens with no user action and no prompt, within 60 s of launch.
4. The helper status is `.enabled` after each update, or re-registration succeeded with no user action.
5. C1 shows the grant reset, so the harness can detect a reset.
6. The result is the same on both macOS majors.
7. Every artifact is notarized, stapled and accepted by Gatekeeper.

**FAIL (S1 negative).** On a valid build, a required cycle (U1, U2, U3, or U4 when required) loses AX or Input Monitoring. Also a FAIL: a grant that comes back only after a user action (re-approval, a toggle, re-adding the app), or a grant where the functional check fails while the trust check says `true`. Do not average results across channels or macOS majors. Any failing channel or major is a FAIL for S1 until its cause is known.

**Not a FAIL, but record it:** the grant survives but the System Settings entry is the helper, not the app, or the entry name changes. This affects onboarding copy and §5.2. It does not affect the grant.

**INVALID (rerun; do not decide S1 from it):**

- A build changed the designated requirement, Team ID or a bundle ID by mistake.
- The baseline is not green.
- The helper was not started by launchd (`helper_ppid` is not `1`), or a check ran from Terminal or Xcode.
- A stale grant was present, because `tccutil reset` was not run.
- A prompt appeared during a check.
- C1 did not show a reset.
- An artifact was not notarized or stapled.

**After FAIL:** the fallback is to run capture in the main app process (D5), and drop the helper for the MVP. The product owner decides and the plan is updated (§13).

**After PASS:** mark S1 as passed in §10. Still re-run the check on the first real MVP build before the Phase 1 gate, because the minimal spike app is not the MVP shell.

## 8. Evidence to record

Keep the raw evidence out of the repo. Screenshots may show account names. Store them in the team's evidence location and record the results table below in the run record.

**Environment:** run ID, date, tester, reviewer. Mac model, chip, `sw_vers`, `xcodebuild -version`. Spike commit SHA and the build number of each build.

**Identity:** the section 2 table filled in. The `codesign -dv --verbose=4` and `codesign -d -r-` output for each build and for each installed copy. A diff of the designated requirements (empty means identical).

**Notarization:** the submission IDs and final status, and the `stapler validate` and `spctl` output for each artifact.

**Install and update, per cycle:** channel, exact command, start and end time, exit code. The helper PID and its parent PID (`helper_ppid`). The SMAppService status before and after. Whether re-registration was needed.

**Grant checks, per cycle:** the JSON lines, with time to first green. Screenshots of Privacy & Security for Accessibility and Input Monitoring before and after each update, showing the entry name and toggle state. Screenshots of any prompt, with its time. The Screen Recording value (recorded only).

**Control and reboot:** the C1 results, the reboot and login times, and the check results after login.

**Optional, for the §5.5 budgets:** helper CPU and RSS during the run. Record only. Optionally save `log show --last 30m --predicate 'subsystem == "com.apple.TCC"'`, and adjust the predicate if it returns nothing.

**Results table (one row per cycle):**

| Run | macOS | Channel | Cycle | Helper status | AX | IM | Prompt? | Time to green | Verdict |
|---|---|---|---|---|---|---|---|---|---|
| | | | | | | | | | |

**Verdict:** PASS, FAIL or INVALID, per section 7, with the reasons and any deviation from this checklist.

## 9. After the run

One follow-up change, outside this item:

- §10 S1 row: status and date.
- §12 risk "TCC attribution breaks on updates": update the mitigation or the residual risk.
- §14 unverified item "TCC attribution for SMAppService helpers": move it to verified, or record the result.
- §4 and §5.1: adjust if the attribution or entry label differs from the text.
- The research note `os-capture.md`, its unverified list, the same item.
- If FAIL: §4 and D5 change to the fallback.

## 10. Who must act

- **Tester:** run sections 3 to 8 on physical Macs, on the current and previous macOS majors.
- **Account owner:** provide the Developer ID Application and Installer certificates and the notarization profile.
- **Product owner:** confirm the MVP updater (§4 says Electron, the research note says a Tauri updater). Confirm the fallback if S1 fails (§13).
- **Privacy reviewer:** review the evidence before the verdict is recorded.
