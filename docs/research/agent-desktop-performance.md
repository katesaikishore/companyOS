# agent-desktop: measured behaviour and performance

Recorded 2026-11-01 with the executor code from `main` (commit `dd830ce`). Scope: Linux on X11 only, one machine. macOS and
Windows were not measured here.

**Changed since this record was made (PR #29).** The focus by name is now the built-in adapter's on every platform. The
program only counts an app's windows before it, and a press on Linux is built-in. The stages below that call the program's
focus measure the code before #29, so the production numbers describe the earlier focus path. What the hosted macOS and Windows runners showed is in
[`adapter-smoke-results.md`](adapter-smoke-results.md).

Terms used below. **The program** is the `agent-desktop` command-line tool. The **final pair** is `run-1.json` and
`run-2.json`, two runs of all six stages made with the `bench.mjs` committed with this record. The **earlier runs** are
`earlier-run-1.json` to `earlier-run-4.json`, made with earlier revisions of the script that were not kept. A window is
**lost** when its process exits during a trial, and **stopped** when the benchmark kills it between trials. All figures come
from `scripts/agent-desktop-bench/summarize.py` run over the data files in
[`agent-desktop-bench-data/`](agent-desktop-bench-data).

**Status.** The press, timing and name results are current as of 2026-11-01 for agent-desktop 1.0.2 on the Linux X11 setup
described. They replace the results of the record made on 2026-10-31, which is still readable with
`git show dd830ce:docs/research/agent-desktop-performance.md`. That record flagged its own press timings as unreliable,
because they came only from runs that did not crash, and its stress table gave only died or alive for three trials per
loop, so it had no usable rate for how often a window dies. This one keeps every trial of the recorded runs. Carried over
from the first record and not re-measured: the failure paths, Findings 2 and 3, the `STALE_REF` behaviour and the
provenance check.

## Summary

- **No window was lost in the stages that ran the program's other commands.** None was lost in the `cli` stage
  (155 calls per run, no key sent) or in the 600 focus calls of the `production` stage.
  590 of those started 150 ms or more after a key to the same window, and the 10 first
  calls of the trials followed no key. A program call that starts or ends within a few milliseconds of a key was not tried.
- **The program's own `press` killed the GTK 3 test window in 26 of 30 trials (final pair).**
  Across its three ways of pressing (with its own focus, headless after one focus, and `--headed`), the window died of a
  segmentation fault at a median call of 17 to 20 among the trials that lost it, and
  as early as call 1. The window had the AT-SPI bridge forced on, and `run.sh` starts no other program that
  uses AT-SPI (the bus's clients were not listed). Every trial started after the previous window was stopped or had crashed,
  and in the first record that condition went with a higher crash rate (3 of 3 against 1 of 3, a small sample). So the figure
  may overstate the rate for a window on a fresh bus, and the rate on a real desktop is not known. In the earlier runs,
  36 of 40 trials lost the window.
- **The press that kills the window reports success.** All 818 calls of the program's `press` (three stages,
  final pair) reported `ok`, including the 26 that killed the window. In 22 of those
  26, no key was logged.
- **A loop that copies the program-enabled Linux path lost no window.** The `production` stage calls the executor's focus,
  which goes through the program, then its key press, the built-in `xdotool` adapter. It waits 150 ms and repeats, about
  385 ms per cycle, and it does not use the runner. In 10 trials of 60 cycles
  (600 presses, final pair) no window was lost, every press reported `ok`, and every press logged exactly
  one key. The window's class was set equal to its process name. With the names companyOS stores, the program's focus failed
  for the test window, and for Chromium the stored form was not tried (see "App names").
- **The two mechanisms name apps differently.** The program accepted the process name in both apps tried. It rejected the
  window class in both, and the window title for the test window (the title was not tried on Chromium). companyOS stores
  the window class, normalised, and the built-in press matches it against the window class.

## What was wrong or out of date in the first record

- **Press timings came only from runs that finished without a crash,** so they could not say how often a window dies.
- **The test window logged keys to a fixed path and ignored `KEY_LOG`,** which the other scripts set. A run that used any
  other log path would have reported that no key was delivered. `KEY_LOG` is now required, and the driver sets it.
- **Two findings went stale.** The record said Linux had no built-in press adapter, and that window-ID targeting was not
  implemented. The adapter exists now, and the executor's functions accept a window ID, though nothing in the app passes
  one yet.
- **It said the crash cause was unknown.** That was true then. A cause has since been proposed upstream.

## What was tested

- **Binary.** `agent-desktop` 1.0.2 from npm (`agent-desktop@1.0.2`, Apache-2.0, source repository
  `vercel-labs/agent-desktop`), installed into a scratch folder and not vendored into the product. The SHA-256 of the Linux
  x64 binary checked on 2026-10-31 is `05427281a6746489bc0e15c16698a70a86322125c76c7a9e2f4c2d7a12bf7c5b` (see
  "Provenance"). The benchmark data records only the version string `agent-desktop 1.0.2`, not a hash. npm's latest
  version was 1.0.2 on 2026-11-01.
- **Environment.** The tool versions and hardware are in the `environment` block of each final data file: Ubuntu 24.04.5 LTS, kernel
  Linux 6.18.44-fc-v185, an Intel Xeon at 2.10GHz with 4 logical CPUs and 15.7 GiB of memory (16,091 MiB),
  Xvfb 2:21.1.12-1ubuntu1.9, openbox 3.6.1-12build5, at-spi2-core 2.52.0-1build1, xdotool 1:3.20160805.1-5build1, Node v22.23.4,
  GTK 3.24.41 and Python 3.12.3. By the recorder's account, the machine was a virtual machine, Xvfb ran on a private
  display, the AT-SPI bus ran under a private D-Bus session, and the test window (`ADTestApp`) logs every key it receives to
  a file, so delivery is checked on the app side.
- **Load.** The guest's one-minute load average was 0.1 to 0.4 when each of the six runs started, and 0.0
  for the names-only run. At the start of the four press stages and at the end of the `cli` stage it was 0.2 to 0.5
  in the final pair and 0.1 to 0.8 in the earlier runs. The `names` stage has no reading. No other workload was
  started on the machine, by the recorder's account. Load on the host could not be seen.
- **Executor.** The built `apps/desktop/src/main/agent-desktop.ts` and `platform.ts` from `main`, called from Node against
  the real binary. No fake program.

## Method

`scripts/agent-desktop-bench/bench.mjs` has six stages. Each press stage runs `TRIALS` = 5 trials of up to `CALLS` = 60
presses of `ctrl+a`. Every trial starts a fresh test window, after the previous trial's window was stopped or had crashed.
Before each call the key log is emptied. After each call the script waits 150 ms, counts the keys in the log, and checks
that the window's process is still running. A trial ends at the first call after which the window is gone, and that trial
is kept. One iteration is one call of the stage, defined in the table.

| Stage | One iteration |
|---|---|
| `cli` | One program command, 30 timed calls each, after one first call that is timed but left out of the percentiles. |
| `names` | The same window under four names, to see which names each mechanism accepts. |
| `production` | `handsExecutor(executorFor(platform), …, 'linux')`: the executor's focus (a `list-windows` check, then `focus-window`), then the built-in xdotool press. |
| `agent-desktop-press` | `pressWithAgentDesktop`: `list-windows`, `focus-window`, then `press`. |
| `press-headless` | `press ctrl+a --app <name>` alone, after one `focus-window` before the trial. |
| `press-headed` | `press ctrl+a --app <name> --headed`. |

Percentiles are nearest-rank. They pool every call except each trial's first, across both runs of the final pair. The first
call of each trial is kept in the raw data (`firstMs` and `firstPressMs`). In every stage except `names` and `cli` the
window's class is set equal to its process name (`python3.12`), so both the program and the built-in adapter accept one
name. The `names` and `cli` stages leave the class as GTK derives it.

**Which runs are which.** The final pair (started at 06:20 and 06:25 UTC) used the committed `bench.mjs`.
`names-with-error-codes.json` is a run of the `names` stage alone from the committed script, made before the final pair. The
earlier runs used earlier revisions of the script that were not kept, so what changed cannot be checked. Their files have the
same settings (5 trials, 60 calls, 150 ms, `ctrl+a`) and the same per-trial and per-call fields as the final pair. They differ
in lacking the program's error code in the `names` rows and three `environment` fields (`os`, `xvfb` and `logicalCpus`).
`earlier-run-1.json` and `earlier-run-2.json` ran the first four stages, and `earlier-run-3.json` and `earlier-run-4.json`
ran all six. A few short test runs of a few seconds were made while the script was written and were not kept.

## Commands the CLI actually has

The executor originally assumed `focus --app` and `press --app --shortcut`. Neither exists in 1.0.2. The commands used
here are:

- `focus-window --app <name>`: bring the app's window to the front and confirm focus.
- `press <chord> --app <name>`: send a key chord. From the first record, measured on Linux only: headless by default, which
  refuses to send keys to a window that is not in front (`STALE_REF`), while `--headed` brings the window forward and sends
  the key through the pointer and keyboard input path. The hosted macOS and Windows runs behaved differently (see Finding 2).
- `list-apps`, `list-windows`, `status`, `snapshot --app <name> -i`.

Every call prints one JSON envelope with `ok`. Errors exit with status 1.

## Results

### The program's commands

Median / 90th percentile in milliseconds, 30 calls per command per run, final pair. All 30 calls of every command were `ok`
in both runs, and the window survived the stage in both runs and in all four earlier runs.

| Command | Run 1 | Run 2 |
|---|---|---|
| `status` | 7.6 / 8.5 | 8.7 / 11.7 |
| `list-apps --app` | 21.8 / 28.2 | 22.1 / 25.2 |
| `list-windows --app` | 21.8 / 24.9 | 22.1 / 25.7 |
| `snapshot --app -i` | 28.8 / 31.0 | 30.9 / 34.2 |
| `focus-window --app` | 106.2 / 113.4 | 112.4 / 117.7 |

### Pressing a key

Final pair. "Lost at call" counts the press after which the window was gone. One iteration is defined in the Method table, so
the production row is a focus call and a press call, the second row is three program calls, and the last two rows are one
program call each.

| Path | Trials | Window lost | Iterations | Press reported `ok` | Keys logged | Lost at call (range, median among those lost) | Per iteration, median / p90 (ms) |
|---|---|---|---|---|---|---|---|
| Production: executor focus, then built-in xdotool press | 10 | 0 | 600 | 600 | 600 | not lost | focus 135.3 / 146.4, press 98.4 / 106.3, together 234.6 / 249.2 |
| Program press with its own focus (`pressWithAgentDesktop`) | 10 | 9 | 288 | 288 | 281 | 2 to 52, median 20 | 184.9 / 195.8 |
| `press`, headless, after one focus | 10 | 8 | 322 | 322 | 314 | 1 to 60, median 17.5 | 50.4 / 57.2 |
| `press --headed` | 10 | 9 | 208 | 208 | 201 | 1 to 32, median 17 | 84.1 / 92.6 |

How to read the table:

- **Window lost.** All 26 lost windows exited on SIGSEGV, and in all of them Python's fault handler reported a
  fatal error. The first record reported a fault at `gtk_main_do_event` in libgtk-3 (the upstream note says it came from a
  `gdb` run). That output was not saved in the repository, and no stack was captured for these runs.
- **Calls and keys.** For the program's press, the key count falls short of the call count by the number of calls that
  killed the window without a key being logged: 7 of 9 (own focus), 8 of 8 (headless) and 7 of 9
  (headed). The other 4 fatal presses logged their key and then the window died.
- **Per-iteration times.** "Together" is the median of the focus time plus the press time within each iteration
  (235 ms here, against 233.8 ms for the two medians added). The production focus time
  includes the executor's `list-windows` check, which accounts for most of its difference from the `focus-window` median in
  the first table (a `list-windows` call takes about 22 ms). The program press with its own focus includes the same
  check. The slowest single press in the production stage was 125.0 ms, and the slowest focus was
  365.0 ms.
- **What the production press does.** The press is the built-in adapter's: it activates the window, checks that the active
  window is one of the app's windows, and sends the key with `xdotool key`.
- **Focus failures in the production stage of the final pair:** none in the final pair. The loop presses even after a failed
  focus. In the product a failed focus ends the run as failed.

Which trials lost the window, by run (a trial that lost it at call 60 made all 60 presses, and the window died on the last):

| Path | Run | Trials that lost the window | Lost at | Trials that did not |
|---|---|---|---|---|
| Program press with its own focus | 1 | 4 of 5 | trial 2 at call 48, trial 3 at call 44, trial 4 at call 52, trial 5 at call 13 | trial 1 |
| Program press with its own focus | 2 | 5 of 5 | trial 1 at call 2, trial 2 at call 17, trial 3 at call 24, trial 4 at call 8, trial 5 at call 20 | none |
| `press`, headless | 1 | 4 of 5 | trial 1 at call 28, trial 2 at call 2, trial 3 at call 48, trial 5 at call 60 | trial 4 |
| `press`, headless | 2 | 4 of 5 | trial 1 at call 52, trial 3 at call 1, trial 4 at call 4, trial 5 at call 7 | trial 2 |
| `press --headed` | 1 | 4 of 5 | trial 1 at call 1, trial 3 at call 29, trial 4 at call 16, trial 5 at call 17 | trial 2 |
| `press --headed` | 2 | 5 of 5 | trial 1 at call 21, trial 2 at call 22, trial 3 at call 4, trial 4 at call 6, trial 5 at call 32 | none |

### Earlier runs

The four earlier runs agree with the final pair. Production: 0 of 20 trials lost a
window, in 1,200 presses, of which 1,200 reported `ok` and 1,200 logged a key.
Focus failures in those runs: earlier run 4, trial 3, call 21: 874.6 ms, and the press after it was ok and logged a key. The cause was not examined. Program press with its own focus:
19 of 20 lost the window (earlier run 1: all 5 lost, at calls 22, 10, 4, 5, 4; earlier run 2: all 5 lost, at calls 43, 3, 5, 12, 15; earlier run 3: all 5 lost, at calls 19, 3, 36, 17, 18; earlier run 4: 4 of 5 lost, at calls none (60 presses made), 14, 8, 20, 10). Headless:
9 of 10. Headed: 8 of 10. The two
raw press stages ran in earlier runs 3 and 4 only.

### App names

companyOS reads the X11 window class (`WM_CLASS`) of the active window and stores it normalised (`normalizeAppName` in
`packages/core/src/classify.ts`: lower-cased, trimmed, a trailing `.app` or `.exe` removed, spaces collapsed), for example
`testapp.py`. A focus step on Linux with the program path set passes that stored name to `focus-window --app`. The built-in
press matches it against the window class, and in all 7 `names` runs it accepted `testapp.py` for the class
`Testapp.py`. The program matched the name of the process in both apps tried. With the test window's class left as GTK derives
it (`Testapp.py`, process `python3.12`), the `names` stage gave the same ok-or-failed result in all 7 runs (the
six runs and the names-only run). The final pair's rows and `names-with-error-codes.json` carry the program's error code:

| Name given | Program `focus-window` | Built-in press | Keys logged |
|---|---|---|---|
| `python3.12` (process name) | ok | refused | 0 |
| `Testapp.py` (window class, as the adapter reports it) | `APP_NOT_FOUND` | ok | 1 |
| `testapp.py` (class as companyOS stores it) | `APP_NOT_FOUND` | ok | 1 |
| `ADTestApp` (window title) | `APP_NOT_FOUND` | refused | 0 |

A second app also had a class that the program did not accept. One Chromium build (Google Chrome for Testing 153.0.8010.12, at
`/opt/pw-browsers/chromium-1243`, started with `--force-renderer-accessibility`) has the class `Chromium-browser` by `xprop`,
and the program's app list names its process `chrome`. `scripts/agent-desktop-bench/names-probe-chromium.sh` tried five
spellings with `focus-window --app`, and its output, with the temporary profile path replaced by `<profile>`, is in
`names-probe-chromium.txt`: `Chromium-browser`, `chromium` and `Chromium` returned `APP_NOT_FOUND`, and `chrome` and `Chrome`
succeeded, so for that one name the match was not case-sensitive. The stored form, `chromium-browser`, and the window title were
not tried on Chromium, and the built-in press was not tried on it.

What this means, for the executor before #29: the program rejected the stored name `testapp.py`, so its focus step would
return failure. Since #29 the focus is built-in and the program's answer only sets the window count, so this no longer fails
a focus (see Finding 6). For Chromium it rejected `Chromium-browser` and `chromium`, and matching looks case-insensitive (`chrome` and
`Chrome` both worked), so the stored form `chromium-browser` would very likely fail too, but it was not tried. The production
numbers above were taken with a window whose class equals its process name, so they show speed and survival, not how often the
names line up. Two apps is too few to say how common the mismatch is. Two ways to close it, neither built: fall back to the
built-in focus when the program answers `APP_NOT_FOUND`, or find the process name from the window's `_NET_WM_PID`.

Failure paths measured in the first record, and not re-measured here: a chord that fails the executor's check is refused with
nothing started, a missing app exits with status 1 in about 17 ms, an empty path is reported as `blocked` with nothing
started, and a headless press to a window that is not in front is refused with `STALE_REF` and sends no key (on Linux).

## Crash in the press path

Every loss happened in a stage that called the program's `press`. The figures are in the Summary and the table above.

A cause has been proposed upstream in
[vercel-labs/agent-desktop#384](https://github.com/vercel-labs/agent-desktop/pull/384), an open pull request with a proposed
fix. Its author attributes the crash to the short-lived `agent-desktop` process: when the last AT-SPI client leaves the bus
right after a key, at-spi2's ATK bridge in the app removes its key listener while the app may still be inside it. The author
reached this by reading the at-spi2-core source and by timing tests, and did not capture the crash inside that call. A Python
replay of our AT-SPI calls that did not crash would be explained if it kept one bus connection, which cannot be checked
because its script was not kept. The higher rate after stopping an earlier window (3 of 3 against 1 of 3, a small sample) is
not explained by the proposed cause. This record did not test the cause. The evidence from the first investigation, and our
alternative change, [vercel-labs/agent-desktop#408](https://github.com/vercel-labs/agent-desktop/pull/408) (open; it has not
been run against a live X11 session), are in
[`agent-desktop-press-crash-upstream-issue.md`](agent-desktop-press-crash-upstream-issue.md). npm's latest release was 1.0.2
on 2026-11-01, the version tested, so no release with a fix was benchmarked.

## Decision (made 2026-10-31; the choice stands after this re-recording)

- Linux key presses do not go through agent-desktop. They use `xdotool` on X11, which the Linux platform already
  requires, after a check that the app is in front. The supporting numbers are new (final pair): 600 presses
  in 10 trials with no window lost, instead of 360 presses in six trials, and 26 of
  30 trials lost for the program's press, instead of 3 of 3. With the program path set, focus and press
  together cost about 235 ms (median), against about 184.9 ms for the program's own press with its own
  focus, which lost the window in 9 of 10 trials. The 235 ms holds only for an app
  whose recorded name is also the program's process name. For the test window it was not, so on Linux the program's focus step
  currently fails for it (see "App names"). The default path, with the program off, was not timed here.
- agent-desktop stays optional and off by default. Focus and press on macOS and Windows already have built-in adapters.
  The program is not needed for them and is not enabled by default until it is measured on those systems over repeated
  presses and the checks still open under "Provenance" (release attestation, source review, re-signing) are done.

## Findings

1. **The executor's command shape was wrong in the first version.** It called commands the CLI does not have. This was
   fixed. The unit tests used a fake program, so they could not catch it, and `bench.mjs` now runs the executor against the
   real binary.
2. **A headless press to a background window does not work, and fails differently on each system.** On Linux, from the first
   record, it is refused with `STALE_REF`. On the hosted macOS runner the same call reports success and delivers nothing,
   and on Windows it fails with `ACTION_FAILED` ([`adapter-smoke-results.md`](adapter-smoke-results.md)). The executor
   therefore runs `focus-window` before every program press, which matches the built-in adapters.
3. **Two windows of one app are ambiguous.** Not re-measured. Since the first record the executor refuses a name that
   matches several windows, and its functions accept a window ID (`apps/desktop/src/main/agent-desktop.ts`), though nothing
   in the app passes one yet.
4. **The program's press killed the GTK 3 test window, and returned `ok` for every press that did.** 26 of
   30 trials in the final pair. Not tested: what the runner would record if the app died during a press. The
   Linux path does not call the program's press, and the runner's check of the front app after a press was not run against a
   dead window.
5. **Linux has a built-in press adapter.** The first record said it did not. Pressing a shortcut on X11 through `xdotool`
   was merged in PR #4.
6. **The two mechanisms name apps differently.** See "App names". Before #29 this could fail a Linux focus, because the
   focus went through the program. Since #29 the focus is built-in, and the program only counts an app's windows, so a
   name mismatch can miss an app's several windows but cannot fail a focus.

## Limits

- Linux on X11, one machine, one GTK 3 test window, and one Chromium name check. Not GNOME, KDE or Wayland. Wayland sessions
  are out of scope: `platform.ts` offers no capture, focus or key press there, and agent-desktop was not tried under it.
- The test window is a plain Python GTK 3 window with the AT-SPI bridge forced on (`GTK_A11Y=atspi`). `run.sh` starts no other
  program that uses AT-SPI, and the bus's clients were not listed. Other toolkits and real applications may behave
  differently, and a real desktop has other clients. Only the program's `press` was found to lose a window.
- Only the chord `ctrl+a`, with a 150 ms wait after each call. The medians were measured at that cadence and may differ at
  others. Trials ran one after another on one bus, each after the previous window was stopped or had crashed. In the first
  record that condition went with a higher crash rate (3 of 3 against 1 of 3, a small sample that the proposed cause does not
  explain).
- The six runs were started on one machine between 05:32 and 06:25 UTC, so they are not independent samples.
  Each press path has 10 trials in the final pair and up to 30 in all, of up to 60 presses, so the medians of the call at which
  the window is lost are rough.
- The production stage called the executor in a loop, without the runner. The runner, and a program call that starts or ends
  within 150 ms after a key, were not tested. The runner stops at a failed focus, and the loop did not.
- Timings are from a virtual machine whose host load could not be seen. The guest's own load was low. They show relative
  cost, not what a user's machine does.
- `xdotool` is version 3.20160805, the version in Ubuntu 24.04. A newer one was not tried.
- The crash cause was not re-tested. Neither upstream proposal was built or run here.
- The end-to-end suite uses a fake front-app source, so it does not exercise this executor.
- Binary provenance is covered below, with its own limits.

## Reproducing

The scripts are in `scripts/agent-desktop-bench/`. They need the Linux packages `at-spi2-core`, `openbox`, `xvfb`,
`dbus-daemon` (for `dbus-run-session`), `python3-gi`, `gir1.2-gtk-3.0`, `xdotool` and `x11-utils`, plus Node 22 and a built
checkout (`npm run build`). The driver defaults to `/usr/bin/python3.12` for the test window (set `PYTHON`, and `APP_NAME` if
the file's name is not the process name). If you run from a Wayland session, unset `XDG_SESSION_TYPE` first, because
`choosePlatform` offers no Linux adapter when it says `wayland`.

- `run.sh` starts the AT-SPI bus and the window manager and runs `bench.mjs`. Set `AGENT_DESKTOP_BIN` to the binary's path
  and run it under `xvfb-run` and `dbus-run-session`:
  `AGENT_DESKTOP_BIN=… OUT=run.json xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/run.sh`. Set `STAGES`,
  `TRIALS`, `CALLS` or `CLI_CALLS` to run less. Run it on a quiet machine: another busy process changes the timings.
- `summarize.py <data folder>` prints every figure used in this record, computed from the data files. It stops with an
  assertion if a statement made here stops being true of the data (for example that every program press reported `ok`).
- `testapp.py` is the test window. It needs `KEY_LOG`, the file it logs keys to, which `bench.mjs` sets.
- `names-probe-chromium.sh` is the Chromium name check. It starts its own bus and window manager, needs a Chromium (set
  `CHROMIUM`), and does not need the build.
- The raw results are in `docs/research/agent-desktop-bench-data/`: the final pair with every call (`run-1.json`,
  `run-2.json`), the four earlier runs (`earlier-run-1.json` to `earlier-run-4.json`), the names stage with error codes
  (`names-with-error-codes.json`) and the Chromium probe output (`names-probe-chromium.txt`).

## Provenance

Checked 2026-10-31 for `agent-desktop@1.0.2` on a Linux x86_64 container. The package was installed into a scratch folder
outside the repository, and the release files were downloaded into separate scratch folders. The only code that ran was
the package's own postinstall script (during `npm install`) and `agent-desktop --version`, which printed
`agent-desktop 1.0.2`.

### Verified

- **Registry signature.** `npm audit signatures` (npm 10.9.9) reported "1 package has a verified registry signature".
- **Provenance attestation.** The same command reported "1 package has a verified attestation". The attestations endpoint
  (`https://registry.npmjs.org/-/npm/v1/attestations/agent-desktop@1.0.2`) returned two bundles:
  - an npm publish attestation, and
  - a SLSA provenance v1 attestation signed through Sigstore, with a certificate that names
    `https://github.com/vercel-labs/agent-desktop/.github/workflows/release.yml@refs/heads/main`. It records git commit
    `a47ed664e0db00d1d4df364eb3fe8a5599882f3c`, a GitHub-hosted runner, and run 41127710341.
- **The attested file is the file we have.** Both bundles name the package by its SHA-512, and that digest equals the
  SHA-512 of the tarball downloaded from the registry (`936422dd...e34d7d3`).
- **Publisher.** The registry shows the publish was made by GitHub Actions through npm trusted publishing (OIDC), not by a
  person's token. The one npm maintainer is `lahfir`. The package licence is Apache-2.0.
- **Tag and commit agree.** `git ls-remote` shows tag `v1.0.2` of `vercel-labs/agent-desktop` at
  `a47ed664e0db00d1d4df364eb3fe8a5599882f3c`, the commit named in the provenance.
- **Shipped binaries against their `.sha256` files.** All 10 binaries in the tarball match the digest in the `.sha256`
  file next to them: the CLI for `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64` and `win32-x64`,
  the two Linux clipboard helpers, and the two macOS helpers.
- **Shipped binaries against the GitHub release.** The release `v1.0.2` has a `checksums.txt`. The six CLI archives
  downloaded from the release match it, and the binaries inside them are byte-identical to the ones in the npm package
  (10 of 10, compared by SHA-256). SHA-256 of the Linux x64 CLI: `05427281a6746489bc0e15c16698a70a86322125c76c7a9e2f4c2d7a12bf7c5b`.
- **Install behaviour.** The postinstall script found the bundled binary's digest equal to its `.sha256` file, so it made
  no download. Otherwise it downloads the release archive and checks it against `checksums.txt`. It then replaces the
  Node launcher `bin/agent-desktop` (5,041 bytes in the tarball) with a hard link to the native binary.

### Not verified, and why

- **The `.sha256` files are not independent.** They ship inside the same tarball as the binaries, so they catch a damaged
  download, not a tampered package. The independent checks are the Sigstore attestation and the release comparison above.
- **GitHub's own attestations for the release archives.** The release workflow attests the archives and `checksums.txt`,
  and its comment says to check them with `gh attestation verify`. That call and the GitHub REST API were refused from this
  container (HTTP 403, repository access not enabled for this session), so the release assets were checked only against
  `checksums.txt`. `checksums.txt` is published by the same workflow, so it is the same trust root as the npm package.
  Run `gh attestation verify <archive> --repo vercel-labs/agent-desktop` on a machine with GitHub access to close this.
- **The release page itself.** Who published it, when, and whether it is marked immutable were not read, for the same
  reason. The tag commit was read through git only.
- **The source code.** No audit was made of what the binary does. The provenance says where it was built, not that it is
  safe. The build container image and Rust toolchain pins in `release.yml` were seen but not reviewed.
- **Platform signing of the binaries.** The binaries are not signed by a platform vendor. The two macOS arm64 binaries
  carry only an ad-hoc signature (a code directory and no certificate chain). The macOS x64 binaries and both Windows
  `.exe` files carry no signature. With no Developer ID signature, none can be notarised. A copy placed inside companyOS's
  own signed and notarised macOS app would have to be re-signed with our certificate, and Windows would treat it as an
  unsigned program.
- **Not run in this check.** The provenance check compared the macOS and Windows binaries by hash only and started only the
  Linux x64 binary. The hosted-runner smoke run did start the macOS arm64 and Windows x64 binaries
  ([`adapter-smoke-results.md`](adapter-smoke-results.md)).
- **Later versions.** All of this applies to 1.0.2. A new version needs the same checks.

### What this means for enabling it

The package is traceable to a public workflow and commit, and the binaries we would use match the published release. That
is enough to use it as an optional, user-installed program, which is how companyOS treats it today. It is not enough to
bundle a copy: that needs the release attestation check above, a source review, and a decision on re-signing. Repeated-press
behaviour and timings on macOS and Windows have not been measured (see the scope line at the top, and
[`adapter-smoke-results.md`](adapter-smoke-results.md) for the hosted-runner smoke run, which made only a few calls per
command).
