# companyOS Twin

A private, employee-owned work twin for macOS, Windows and Linux. It notices how you work across apps, builds a twin of your routines, and offers automations. It runs an automation by itself only after that automation has proven itself.

- Plan and research: [`docs/plan`](docs/plan/README.md) and [`docs/research`](docs/research/)
- Stack: Electron (desktop shell and UI) with a TypeScript core engine (`packages/core`)

## Principles (enforced in code and tests)

- **Raw activity stays on the device.** Stored records are AES-256-GCM sealed under a key held in the OS keychain.
- **No titles, no keystrokes, no URL queries.** Redaction happens at ingest. Secure input, private windows and excluded apps produce no event.
- **Open models only.** The twin runs open-weight models (Apache-2.0 or MIT) on this device. No closed or hosted model receives any data. Models come from a fixed catalogue with pinned SHA-256 digests.
- **Network calls are listed.** The only network traffic is model downloads. Each one is recorded in the network ledger with its host, path, size and checksum result. No personal data is sent.
- **Autonomy is earned.** Drafts never execute. One-click runs ask before any external step. Unattended runs need level 4, local and reversible effects only, and a promotion gate.
- **Fail closed.** If the OS cannot protect the key, the twin does not start. On Linux without a real keyring, it does not start either.

## Layout

```
packages/core       Engine: redaction, encrypted store, segmentation, routine mining,
                    automations, policy, runner, autonomy gates, open-model catalogue,
                    hardware planning, verified downloads (Vitest)
apps/desktop        Electron app: main process (capture, OS control, model installs, IPC),
                    sandboxed preload, renderer (TypeScript modules, no framework)
apps/desktop/test   End-to-end tests against the built app (Playwright + Electron)
.github/workflows   CI on macOS, Windows and Linux
docs/               Plan and research
```

## Build and run

Requires Node.js 22 or later.

```bash
npm ci
npm run typecheck
npm test            # engine tests
npm run build       # core + desktop
npm start           # run the app from source
npm run dist:dir    # package an unpacked app for this platform
npm run dist        # installers, unsigned unless signing environment variables are set
```

End-to-end tests (Linux, headless; needs network access to huggingface.co for the embedding-model download):

```bash
npm run build
NODE_PATH="$(npm root -g)" xvfb-run -a node apps/desktop/test/e2e.cjs
```

On Linux without a keyring, the app refuses to start. The end-to-end test sets `COMPANYOS_TEST_BASIC_STORE=1` to get past this in CI. Never set it for real data.

## What works

- Engine: redaction, encrypted storage, segmentation, routine mining, compilation into automations, policy, runners (dry, supervised, unattended), promotion and demotion gates, dismissals, a stop-all switch, and time estimates.
- Setup: the wizard detects the device (CPU, memory, GPU vendor, free disk) and recommends the largest open chat model that fits, plus the embedding model. Downloads are verified and cancellable.
- Pages: an overview with first-run guidance, local app-usage bars and a routine timing map; suggestions; automation detail with the autonomy ladder and promotion gate; network ledger; and settings. Light and dark themes. `Ctrl/⌘ K` opens a searchable command palette for pages, routines, and capture controls.
- Tray popover with the stop-all button. The stop-all shortcut is Control+Alt+. (it is skipped if another app owns it).
- Level 4 routines run on their trigger only when unattended runs are enabled, the global automation switch is on, and the configured maximum allows level 4. They remain limited to local, reversible steps and show a native completion or stop notification.
- Stop all cancels the remaining steps of an in-flight routine, even if automations are turned back on immediately. Privacy and autonomy settings are re-read after approval dialogs and before each step.
- Capture adapters: macOS (System Events, asks for Automation permission), Windows (PowerShell with `GetForegroundWindow`), Linux X11 (xdotool). Idle and lock from Electron's `powerMonitor`.

## What does not work yet

- **Model use.** Installed models are not yet loaded. Routine labels and names still come from rules. Running the local model is the next step.
- **Wayland.** App capture needs a compositor extension. It is reported as unavailable.
- **Native capture.** The polling adapters are a stand-in. Native helpers (Accessibility, UI Automation, AT-SPI) are the target. Polling costs more CPU, especially on Windows.
- **Browsers.** Browser capture is off by default. The twin can only record the app name, and it cannot tell a private or incognito window from a normal one yet. A browser extension that detects private windows is the fix.
- **Lock on Linux.** Electron does not report screen lock on Linux, so capture relies on the idle threshold there.
- **Keystroke counts and screenshots.** Not captured in this version.
- **Storage.** The MVP uses record-level AES-GCM over an append-only log. The plan targets SQLCipher, which needs a native build spike on all three OSes.
- **Signing and notarisation.** Installers are built unsigned. Release signing needs the secrets listed in `apps/desktop/electron-builder.yml`.
- **Company mode.** Not started.

The architecture target in [`docs/plan`](docs/plan/README.md) describes a future Rust/Tauri design. The current desktop MVP on this branch is Electron with a TypeScript core, as described above.

## Notes for reviewers

- Model downloads go only to `huggingface.co` and `*.hf.co`, over HTTPS, and every redirect hop is checked against that list.
- `apps/desktop/src/main/preload.ts` repeats the channel names on purpose: sandboxed preloads cannot import local modules.
- The renderer is served from the `app://` scheme. Chromium blocks ES module scripts loaded from `file://`, so the protocol is what lets the pages load.
