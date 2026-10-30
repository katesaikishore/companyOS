# companyOS Twin

companyOS Twin is a private desktop app for macOS, Windows and Linux (X11). It notices the apps you use in the
same order again and again, such as a spreadsheet, then a document, then an editor, and offers to run that order
as an automation. A new automation starts as a draft. You can run it with your approval, and it runs on its own
only after it has earned that. Your activity is stored encrypted on your device. This is an early preview.

## Principles

- Raw activity data stays on the device, in an encrypted store.
- Open-weight models only. Every model is Apache-2.0 or MIT, comes from a fixed catalogue, and is checked
  against a SHA-256 digest.
- Automations run on their own only after they have earned it.
- It fails closed if the OS cannot protect its key. The app does not start.

## Status

**Works today**

- **Capture.** Reads the name of the app in front on macOS, Windows and Linux X11, with pause, idle detection
  and an exclusion list. Titles, page text and typed text are never read. With Watch browsers on (off by default,
  macOS and Linux only), Chrome and Edge are recorded too, as the host and path shape of the active tab. The
  extension never reports incognito windows.
- **Store.** One SQLCipher database, opened with a 32-byte key that the OS keychain seals. It includes export
  (a plain file, after a warning), Delete everything, and 90-day pruning of raw events.
- **Routines.** Fixed rules find repeated app sequences and offer them as suggestions. An accepted one becomes
  a draft, which can be dry-run. At level 3 you start each run, from a tray offer or with **Run now**, and steps
  with external effects ask again. At level 4, with **Allow unattended runs** on, a routine with only local,
  reversible steps runs on its own when its app comes to the front. Otherwise level 4 works like level 3. An
  offer never starts a run by itself.
- **Autonomy.** Autonomy levels, a deterministic policy check before every step, a promotion gate to level 4,
  and demotion after a failed or undone run. Stop all automations is one switch.
- **Downloads.** Installing a model fetches it only from Hugging Face hosts and checks its SHA-256 digest.
  Each download that runs is written to the network ledger.
- **Routine names.** An installed chat model can name routines in a background worker, and the rule-based name
  is the fallback. Names are kept in memory only. Not verified with a real model file, because the tests use
  a fake worker.
- **OpenMausBot handoff.** Sends a task brief to an external CLI after a native confirmation. Not run against
  the real CLI. The privacy suite checks its prompt and arguments against a fake CLI.

**Not done yet**

- **Model use** stops at naming. Routine detection, labels, policy and safety checks are rule-based. The
  embedding model is downloaded but never loaded.
- **Steps** are limited. Focus and check work wherever app capture works. Opening a web link or one file works
  on macOS and Windows only, and a file asks each time. Pressing keys has no adapter on any OS, so it is always
  blocked. Typing, clicking and sending are not built. Level 5 is not built.
- **Platforms.** Wayland has no app capture. Linux cannot open links or files. Windows has no browser capture,
  because its native host registration is not written.
- **Capture** polls every 3 to 5 seconds with OS tools. There are no native helpers and no keystroke counts.
  The poll cannot see private windows, so with Watch browsers on, an incognito Chrome window is recorded under
  the browser's name.
- **Delete everything** removes the store and the data key. It does not remove model files or any export you
  saved, although its dialog says installed models are removed.
- **Company mode** is not built. `packages/core/src/company` holds only the aggregate release maths (cohort
  minimum, noise, privacy budget). Nothing sends or shows it.
- **Packaging** is built in CI (unpacked, unsigned), but no test starts a packaged app. Signing and notarisation
  run only when certificates are set. `apps/desktop` does not declare `@companyos/twin-core`, which its main
  process imports, so a packaged app may not start.
  Auto-update checks run only when `COMPANYOS_UPDATE_URL` is set, and no update feed exists yet.

## Quick start

Prerequisites: Node.js 22 or later, and npm. CI uses Node.js 22.

- **macOS:** when asked, allow Automation for System Events.
- **Linux:** an X11 session with `DISPLAY` set, `xdotool` installed, and a keyring Electron can use (GNOME
  Keyring or KWallet). Without a keyring the app does not start. Wayland is not supported.

```bash
npm ci                  # install, and download the Electron 45.1.0 binary
npm run typecheck
npm test                # engine, desktop, browser extension and measurement unit tests
npm run build
npm start               # build, then launch the app from source
npm run test:privacy    # privacy leak suite: planted canaries must not reach any output
```

The end-to-end script, `apps/desktop/test/e2e.cjs`, needs a build, Playwright and a display, and it downloads
the embedding model from huggingface.co. Run `npm run build`, then `npm install --no-save playwright`, then
`npm run test:e2e` (under `xvfb-run -a` on a Linux machine without a display). The end-to-end test runs in CI
on Linux only. CI (`.github/workflows/ci.yml`) runs typecheck, unit tests, the privacy suite, build and
packaging on macOS, Windows and Linux.

## Layout

- `packages/core`: the twin engine. Redaction, store, segmentation, mining, automations, policy, autonomy and
  the naming job. Unit tests are in `packages/core/test`.
- `apps/desktop`: the Electron app. `src/main` is the main process, and `src/renderer` is the UI, with no
  framework. `test/e2e.cjs` is the end-to-end script.
- `apps/browser-ext`: the Chrome and Edge bridge, a Manifest V3 extension and its native messaging host.
- `tests/privacy`: the planted-canary leak suite.
- `scripts/measure`: a CPU and memory sampler for the budgets in plan section 5.5, run with `npm run measure`.
- `docs`: the plan, the research notes and the screenshots.

## Docs

- [`docs/plan/README.md`](docs/plan/README.md): the product plan and decision log. Its section 16 describes an
  older MVP: it says the browser extension is not built, and it names AES-256-GCM logs as the store. Check
  Status in this README first.
- [`docs/research/`](docs/research/): research notes on automation and autonomy, OS capture, prior art, privacy
  and law, and understanding and ML.
