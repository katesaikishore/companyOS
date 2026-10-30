# companyOS Twin

A private, employee-owned work twin for macOS, Windows and Linux. It notices how you work across apps, builds a twin of your routines, and offers automations. It runs an automation by itself only after that automation has proven itself.

- Plan and research: [`docs/plan`](docs/plan/README.md) and [`docs/research`](docs/research/)
- Stack: Electron (desktop shell and UI) with a TypeScript core engine (`packages/core`)

## Principles (enforced in code and tests)

- **Raw activity stays on the device.** Stored records are AES-256-GCM sealed under a key held in the OS keychain.
- **No titles, no keystrokes, no URL queries.** Redaction happens at ingest. Secure input, private windows and excluded apps produce no event.
- **Cloud only with consent, and only anonymised traces.** Claude is off by default. The only thing it may receive is a strict schema of pseudonymised app tokens and window classes. Every call is written to a ledger the owner can read.
- **Autonomy is earned.** Drafts never execute. One-click runs ask before any external step. Unattended runs need level 4, local and reversible effects only, and a promotion gate.
- **Fail closed.** If the OS cannot protect the key, the twin does not start.

## Layout

```
packages/core     Engine: redaction, encrypted store, segmentation, routine mining,
                  automations, policy, runner, autonomy gates, cloud trace (Vitest)
apps/desktop      Electron app: main process (capture, OS control, IPC), sandboxed
                  preload, renderer (plain TypeScript, no framework)
.github/workflows CI on macOS, Windows and Linux
docs/             Plan and research
```

## Build and run

Requires Node.js 22 or later.

```bash
npm ci
npm run typecheck
npm test            # core engine tests
npm run build       # core + desktop
npm start           # run the app from source
npm run dist:dir    # package an unpacked app for this platform
npm run dist        # installers (DMG/ZIP, NSIS, AppImage/deb/rpm), unsigned unless signing env vars are set
```

Smoke test (Linux, headless):

```bash
NODE_PATH="$(npm root -g)" xvfb-run -a node apps/desktop/test/smoke.cjs
```

On Linux without a keyring, the app refuses to start because it cannot protect the key. For local testing only, `--password-store=basic` allows it, and that is what the smoke test uses. Do not use it for real data.

## What works now

- Redaction, encrypted storage, segmentation, routine mining, compilation of routines into automations, policy, supervised and unattended runners, promotion and demotion gates, cloud naming with a strict trace, data export and deletion (61 engine tests).
- Desktop shell: single instance, tray, sandboxed window with CSP, validated IPC, native approval dialogs before external steps, and key storage through the OS keychain.
- Capture adapters: macOS (System Events, requires Automation permission), Windows (PowerShell with `GetForegroundWindow`), Linux X11 (xdotool). Idle and lock from Electron's `powerMonitor`.

## What does not work yet

- **Wayland.** App capture needs a compositor extension (spike S4). It is reported as unavailable.
- **Native capture.** Polling adapters are a stand-in. The target is native helpers (Accessibility, UI Automation, AT-SPI) after the spikes in the plan. Polling costs more CPU, especially on Windows.
- **Browser extension.** URL templates are supported by the engine, but no extension feeds them yet.
- **Keystroke counts.** Not captured yet. Global input hooks need the native helper.
- **Storage.** The MVP uses record-level AES-GCM over an append-only log. The plan targets SQLCipher. That needs a native build spike on all three OSes.
- **Signing and notarisation.** Installers are built unsigned. Release signing needs the secrets listed in `apps/desktop/electron-builder.yml`.
- **App icons.** The tray icon is generated at runtime. Real icons belong in `apps/desktop/build/` before a release.
- **Company mode.** Not started. The plan describes it; the engine has no aggregation yet.

## Notes for reviewers

- The smoke test checks that the page renders, the bridge answers, and there are no page errors. The rest of the desktop behaviour has not been run against real apps. It needs a manual pass on each OS.
- `apps/desktop/src/main/preload.ts` repeats the channel names on purpose: sandboxed preloads cannot import local modules.
