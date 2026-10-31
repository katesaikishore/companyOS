# agent-desktop: measured behaviour and performance

Recorded 2026-10-31 on the `agent-desktop-executor` branch. Scope: Linux only, one machine, X11. macOS and Windows were
not measured.

**Status: partly valid.** The first version of this record said the GTK test app's crash had not recurred. That was
wrong. The crash is reproducible in the press path (see "Crash in the press path"). Focus, status and snapshot timings are
sound. Press timings come from runs that finished without a crash, and are not reliable until the crash is understood.

## What was tested

- **Binary.** `agent-desktop` 1.0.2 from npm (`agent-desktop@1.0.2`, Apache-2.0, source repository
  `vercel-labs/agent-desktop`). Installed into a scratch folder, not vendored into the product. Its publisher and
  signature were not verified.
- **Environment.** Ubuntu 24.04 container, x86_64, 4 cores. Xvfb on a private display, openbox as the window manager,
  an AT-SPI bus (at-spi2-core 2.52.0) under a private D-Bus session, and a GTK 3.24 test window (`ADTestApp`) written in
  Python 3.12. The window logs every key it receives, so delivery can be checked on the app side.
- **Executor.** The built `apps/desktop/src/main/agent-desktop.ts` (this branch), called directly from Node against the
  real binary. No fake program.

## Commands the CLI actually has

The executor originally assumed `focus --app` and `press --app --shortcut`. Neither exists in 1.0.2. The commands used
here are:

- `focus-window --app <name>`: bring the app's window to the front and confirm focus.
- `press <chord> --app <name>`: send a key chord. Headless by default, which refuses to send keys to a window that is
  not in front (`STALE_REF`). `--headed` brings the window forward and sends the key through the pointer and keyboard
  input path.
- `list-apps`, `list-windows`, `status`, `snapshot --app <name> -i`.

Every call prints one JSON envelope with `ok`. Errors exit with status 1.

## Results

Medians from clean runs. Press rows come from runs that did not crash (see below).

| Call | Median | p90 | Result |
|---|---|---|---|
| `status` | 10 ms | 12 ms | ok |
| `list-apps --app` | 24 ms | 25 ms | ok |
| `list-windows --app` | 24 ms | 27 ms | ok |
| `snapshot --app -i` | 32 ms | 35 ms | ok |
| `focus-window --app` | 111 ms | 116 ms | ok |
| `press ctrl+a --app`, window focused | 52 ms | 61 ms | key delivered (10 of 10, clean run) |
| `press ctrl+a --app --headed`, window focused | 84 ms | 88 ms | key delivered (10 of 10, clean run) |
| Executor focus, 20 runs | 113 ms | 122 ms | 20 of 20 ok (clean run) |
| Executor focus then press, 20 runs | 164 ms | 170 ms | 20 of 20 ok; 20 of 20 keys reached the app (clean run) |

Failure paths:

- A chord that fails the executor's check (`notakey`) is refused in 0 ms. Nothing starts.
- An app that is not running (`NoSuchApp`) exits with status 1 in about 17 ms. The executor reports it as `exit`.
- An empty path is reported as `blocked` in 0 ms. Nothing starts.
- A headless press aimed at a window that is not in front is refused with `STALE_REF`. No key is sent. This is the
  safe outcome.
- A headed press aimed at a window that is not in front brings the window forward and delivers the key (clean run).

## Crash in the press path

The GTK test app's process dies with a segmentation fault inside `Gtk.main`. Python's fault handler shows no Python frame
below that, so the fault is native. Stress runs, each on a fresh app with 60 calls per trial:

| Loop | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| `status` | alive | alive | alive |
| `snapshot --app -i` | alive | alive | alive |
| `focus-window --app` | alive | alive | alive |
| `press ctrl+a --app` (headless) | **died** | **died** | **died** |
| `press ctrl+a --app --headed` | **died** | **died** | **died** |
| `focus-window`, then `press` | **died** | **died** | alive |

Controls:

- Plain X11 key events, sent with `xdotool key ctrl+a` (30 per mode, with and without a focus change), did not crash the
  app. No agent-desktop process was involved.
- Earlier runs with focus and press calls finished cleanly. These are the clean-run rows in the results table. The repo
  rerun of the benchmark did crash, and its numbers were discarded.

What this shows: the crash needs agent-desktop's press path, not focus, snapshot or raw key events. What it does not
show: whether the fault is in agent-desktop's press code, in the GTK 3 accessibility bridge in this container
(at-spi2-core 2.52.0), or in the test app. The agent-desktop Linux guide mentions an at-spi2-core bridge fix and an
abort on `Action.GetActions` on other distributions, so the bridge is a likely suspect. That is a lead, not a finding.

Follow-up checks:

- The fault is a native SIGSEGV inside libgtk-3 (`gtk_main_do_event`). No AT-SPI, GTK accessibility bridge or X library frame is on
  the stack.
- The stress script reproduced the crash on a fresh display: headless press died in 3 of 3 trials.
- A Python client that replays agent-desktop's AT-SPI calls, then sends the key, did not crash in 3 trials of 60
  presses. One real press run without the earlier focus calls did not crash either. The reason for the difference from
  the crashing runs is not known.
- Killing an earlier test window before the measured one raised the crash rate: 3 of 3 trials died, against 1 of 3 with
  no earlier window. The sample is small, so this is a lead.
- Until the cause is known, a press through agent-desktop on Linux should not be relied on.

## Decision (2026-10-31)

- Linux key presses do not go through agent-desktop. They use `xdotool` on X11, which the Linux platform already
  requires. In the checks run, `xdotool` keys with the focus check first delivered 360 of 360 presses across six trials
  (including after an earlier window was killed) with no crash. The same loops crashed the agent-desktop press in 3 of 3
  trials. This is on the `linux-press-xdotool` branch, and the executor excludes Linux presses on this branch.
- The root cause of the agent-desktop press crash is still not known. It was not reproduced by a replay of the AT-SPI
  calls, so it may depend on something outside the replay. It is an upstream question, not a companyOS fix.
- agent-desktop stays optional and off by default. Focus and press on macOS and Windows already have built-in adapters.
  The program is not needed for them and is not enabled by default until it is measured there and its binary is verified.

## Findings

1. **The executor's command shape was wrong.** It called commands the CLI does not have. This is fixed on this branch.
   The unit tests used a fake program, so they could not catch it. A real-binary check is now part of the test plan.
2. **Headless press needs focus first.** A press to a background window fails. The executor therefore runs
   `focus-window` before every `press`, which matches the built-in adapters.
3. **Two windows of one app are ambiguous.** When two windows share a process name, name targeting fails with
   `AMBIGUOUS_TARGET`. The executor only takes an app name, so it cannot yet target one of two instances. Window-ID
   targeting (`--window-id`, from `list-windows`) would fix this and is not implemented.
4. **Press can crash the target app.** Under repeated presses the GTK 3 test app dies in most trials. Until the cause is
   found, a press step can take down the app it is meant to type into. This is the most important open finding.
5. **Linux has no built-in press adapter.** `apps/desktop/src/main/platform.ts` states this. With a configured path,
   this executor is the only way to press a shortcut on Linux.

## Limits

- Linux, X11 only, one machine. Not GNOME or Wayland. Not macOS or Windows.
- The crash cause is unknown (see above). The clean-run timings may hide it, so treat the press numbers as provisional.
- The end-to-end suite uses a fake front-app source, so it does not exercise this executor. The executor was tested by
  calling the built module directly.
- Binary provenance (publisher, signature, checksum against an independent source) is not verified. This must be done
  before any binary is bundled or enabled for users.

## Reproducing

The scripts are in `scripts/agent-desktop-bench/`. They need the Linux packages `at-spi2-core`, `openbox`, `xvfb`,
`python3-gi` and `gir1.2-gtk-3.0`, plus Node 22 and a built checkout (`npm run build`).

- `run.sh` runs the executor benchmark. Set `AGENT_DESKTOP_BIN` to the binary's path, then run it under `xvfb-run` with
  `dbus-run-session`. It reports if the test app died during the run, and those results must be discarded.
- `stress.sh` runs each call type 60 times against a fresh app and reports whether the app survived.
