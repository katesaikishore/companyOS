# Backlog status and decisions (31 October 2026)

This records what was finished, what was decided without waiting for the owner, and what still needs someone with access. Each decision names how to reverse it.

Merged to `main` on 31 October: the 900 by 600 window work (through PR #3), and every finished backlog branch. On `main` the type-check, the unit suites (28 files), the privacy suite (39 tests), the build and the end-to-end run all pass.

## Status

| Item | What | Status | Where it landed |
| --- | --- | --- | --- |
| P0-1 | Plan for the uncommitted compact-pass stash | Done (read-only plan) | Superseded by the design rebuild; stash left in place |
| P0-2 | First signed release | Not done | Needs a release tag and signing secrets (see below) |
| P0-3 | Draft GitHub release from a version tag | Done | `release-automation`: `.github/workflows/release.yml`, drafts only |
| P0-4 | Update feed | Done | Off unless `COMPANYOS_UPDATE_URL` is set; tests in `updater.test.ts` |
| P0-5 | TCC spike S1 checklist | Done (checklist) | `docs/plan/tcc-spike-s1.md`; the run needs a physical Mac |
| P1-6 | Merge PR 2 | Done | Merged earlier |
| P1-7 | Design rebuild | Done | `fixed-window-900x600`: the seven screens and the shell, at 900×600 |
| P1-8 | Press-shortcut step | Code done, platforms untested | `press-shortcut`: macOS and Windows adapters, Linux refuses before approval |
| P1-9 | Native capture | Not done | Needs Mac and Windows hardware |
| P1-10 | Windows native messaging | Code done, Windows untested | `windows-native-host`; the runtime still refuses Windows capture |
| P1-11 | Wayland | Not done | Needs GNOME and KDE machines |
| P1-12 | Embedding model check | Report | Catalogue entry is well formed; the licence and digest need network access |
| P1-13 | OpenMausBot handoff | Report | Built as described; the open-models question is flagged below |
| P2-14 | Level 4 tuning | Not done | Needs weeks of real use |
| P2-15 | Level 5 outbox | Proposal | `docs/research/l5-outbox-proposal.md` |
| P2-16 | Company server | Proposal | `docs/research/company-server-proposal.md` |
| P2-17 | MCP export | Proposal | `docs/research/mcp-export-proposal.md` |
| P2-18 | Windows signing | Guide | `docs/plan/windows-signing.md`; no certificate yet |
| P2-19 | Intel Mac | Feasibility report | Go with conditions; no runner yet |
| P3-20 | Firefox and Safari | Firefox build; Safari deferred | `firefox-port`; Firefox visits refused; Safari needs Xcode and an account |
| P3-21 | Vision fallback | Proposal | `docs/research/vision-fallback-proposal.md` |
| P3-22 | OCEL 2.0 export | Done | `ocel-export`: `toOcel2()` in core, with tests |
| P3-23 | Legal templates | Done (drafts) | `legal-templates`: `docs/legal/`, marked DRAFT for counsel |
| P3-24 | Mintlify docs check | Done (check) | `mintlify-check`; the overview image is the 900×600 capture |

## Decisions taken without waiting

- **D1. Window.** The main window is a fixed 900×600 content area. It cannot be resized, maximised or made full screen, and zoom is off. Linux cannot enforce the maximise flag, so any maximise is undone. Reverse: `resizable` and the guard in `main/index.ts`.
- **D2. Design.** The design artifact (seven boards at 1080×720) is the baseline, scaled to 900×600. The OpenMausBot chat composer stays read-only, as you asked. Reverse: none needed.
- **D3. Overview Accept.** The design keeps Accept on "Waiting for you". It creates a draft and runs nothing. Reverse: remove the buttons in `views/overview.ts`.
- **D4. Firefox.** The build merges, but the twin refuses Firefox visits and the add-on ID is a placeholder. The Firefox folder is excluded from the packaged app. Reverse: allow `firefox` in `browser-request.ts`, `host.js` and `native-host-install.ts`, and remove the filter in `electron-builder.yml`.
- **D5. Windows native host.** Registration code merges. Capture stays off on Windows until a named-pipe transport exists and someone has run it on Windows. Reverse: the gate in `native-host-install.ts`.
- **D6. Press shortcut.** It merges. The macOS and Windows adapters are untested here, and Linux has no adapter, so a press step is refused there before anyone is asked. Reverse: remove the step from `executorFor`.
- **D7. Release.** The release workflow merges and creates drafts only on `v*` tags. No tag is pushed: a tag starts the workflow, and that builds installers that are not signed yet. Reverse: none needed; push a tag when signing is in place.
- **D8. Windows signing route.** Route A (Azure Artifact Signing) first, if the company is eligible. Otherwise Route B (an OV certificate on a cloud HSM). Not configured yet.
- **D9. Intel Mac.** Go with conditions. It is not added to the beta until a runner exists.
- **D10. Vision fallback.** Not in the MVP. It waits for the S3 result. Reverse: a decision in the proposal.
- **D11. Level 5 outbox.** Not built in v2 yet. Countdown default 30 seconds, and no send-now at Level 5. Reverse: the decision at Phase 2 exit.
- **D12. MCP export.** The MCP automation surface ships first. Reads of twin data wait for a plan change. No third-party client receives data in v1.
- **D13. Company server.** No hosted DAP service. That keeps section 15a, so the company server is not built.
- **D14. Safari.** Deferred, as the plan already says.
- **D15. Legal templates.** Drafts for counsel only. They are not legal advice, and no facts were invented.
- **D16. Mintlify.** The docs are checked. The overview image is the 900×600 capture. Deployment needs an account.

## Needs someone with access

- **Release tag and signing.** Push a `v*` tag only after signing secrets are set (`CSC_LINK`, `CSC_KEY_PASSWORD`, `WIN_CSC_LINK`, `WIN_CSC_KEY_PASSWORD`, and the App Store Connect key). Then publish the draft by hand.
- **Mintlify account.** Sign in or create one, connect the GitHub app to `katesaikishore/companyOS`, and set the docs path to `docs-site/`.
- **Physical runs.** TCC spike S1 on a Mac; press steps on a Mac and on Windows; the Windows native host on Windows 11; the Intel build on an Intel host.
- **Firefox add-on ID.** Replace the placeholder before the first Firefox release.
- **Counsel review** of everything in `docs/legal/`.
- **Open-models question (plan section 15a).** OpenMausBot handoffs send the brief, routine name, app sequence and cadence to a service that uses its own models. Section 16 sets this aside, and that needs an owner decision.
- **Weeks of real use** for Level 4 tuning, and S3/S4 for vision and Wayland.
