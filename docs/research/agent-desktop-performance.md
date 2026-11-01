# agent-desktop: measured behaviour and performance

Recorded 2026-11-01 with the executor code from `main` (commit `dd830ce`) and the scripts added in the same change as this
record. Scope: Linux on X11 only, one machine. macOS and Windows were not measured here. What the hosted macOS and Windows
runners showed is in [`adapter-smoke-results.md`](adapter-smoke-results.md).

**Status: current for the Linux X11 setup described. It supersedes the record made on 2026-10-31.** That record flagged its
own press timings as unreliable, because they came only from runs that did not crash, and it gave no rate for how often a
window dies. This one keeps every trial of every run, including the ones where the test window died. The failure paths,
Finding 2 and the provenance check are carried over from the first record and were not repeated. The raw data is in
[`agent-desktop-bench-data/`](agent-desktop-bench-data).

## Summary

- **No window was lost to the program's other commands.** None was lost in the `cli` stage (155 calls per run, no key sent)
  or in the 1,200 focus calls of the production stage, where each program call started at least 150 ms after the previous
  key. Whether a call that ends within a few milliseconds of a key can kill a window was not measured.
- **The program's own `press` killed the GTK 3 test window in 36 of 40 trials.** Across the three ways of pressing it (with
  its own focus, headless after one focus, and `--headed`) the window died of a segmentation fault, after a median of 12 to
  20 presses among the trials that lost it, and after as few as 1. The window had the AT-SPI bridge forced on, no other
  AT-SPI client was on the bus, and each trial started after the previous window was gone (killed or crashed), so the rate
  on a real desktop is not known.
- **The press that kills the window reports success.** All 838 press calls reported `ok`, including the 36 that killed the
  window. In 34 of those 36, no key was logged.
- **The Linux X11 path with the program enabled lost no window in the production stage.** That stage calls the executor's
  focus, which goes through the program, and its key press, the built-in `xdotool` adapter, in a loop 150 ms apart, without
  the runner. In 20 trials of 60 presses (1,200 presses) no window was lost, every press reported `ok`, and every press
  logged exactly one key. One of the 1,200 focus calls took 875 ms and returned failure, and the benchmark pressed anyway.
- **The two mechanisms name apps differently.** For the two apps tried, the program accepted the process name and rejected
  the window class and the title. companyOS stores the window class, lower-cased, and the built-in press matches it against
  the window class. See "App names".

## What was wrong with the first record

1. **Press timings came only from runs that finished without a crash.** The record said so and marked them unreliable, but
   they could not say how often a window dies, and its stress table gave only died or alive for three trials per loop. This
   record keeps every trial and the call at which each window died.
2. **The test window logged keys to a fixed path and ignored `KEY_LOG`,** which the other scripts set. A run that used any
   other log path would have reported that no key was delivered. `KEY_LOG` is now required, and the driver sets it.
3. **Two findings had gone stale.** It said Linux had no built-in press adapter, and that window-ID targeting was not
   implemented. The adapter exists now. The executor's functions accept a window ID now, though nothing in the app passes
   one yet.
4. **It said the crash cause was unknown.** A cause has since been proposed upstream (see "Crash in the press path").

## What was tested

- **Binary.** `agent-desktop` 1.0.2 from npm (`agent-desktop@1.0.2`, Apache-2.0, source repository
  `vercel-labs/agent-desktop`), installed into a scratch folder and not vendored into the product. The Linux x64 binary's
  SHA-256 is `05427281a6746489bc0e15c16698a70a86322125c76c7a9e2f4c2d7a12bf7c5b`, the digest checked under "Provenance".
  npm's latest version was still 1.0.2 on the day of the recording.
- **Environment.** Ubuntu 24.04.5 on a virtual machine (a cloud sandbox) with Linux 6.18.44, an Intel Xeon at 2.1 GHz,
  4 logical CPUs and 15.7 GiB of memory. Xvfb 21.1.12 on a private display, openbox 3.6.1 as the window manager, an AT-SPI
  bus (at-spi2-core 2.52.0) under a private D-Bus session, xdotool 3.20160805, Node 22.23.4, and a GTK 3.24.41 test window
  (`ADTestApp`) written in Python 3.12.3. The window logs every key it receives to a file, so delivery is checked on the
  app side. The Ubuntu and Xvfb versions were read from the machine. Every other version is in the `environment` block of
  each data file.
- **Load.** The guest's one-minute load average was 0.2 to 0.4 when each run started, and 0.1 to 0.8 at the start of
  individual stages (the benchmark itself raises it). No other workload was started on the machine. Load on the host and on
  other guests could not be seen.
- **Executor.** The built `apps/desktop/src/main/agent-desktop.ts` and `platform.ts` from `main`, called from Node against
  the real binary. No fake program.

## Method

`scripts/agent-desktop-bench/bench.mjs` has six stages. Each press stage runs `TRIALS` = 5 trials of up to `CALLS` = 60
presses of `ctrl+a`. Every trial starts a fresh test window, after the previous trial's window was killed or had crashed.
Before each call the key log is emptied. After each call the script waits 150 ms, counts the keys in the log, and checks
that the window's process is still running. A trial ends at the first call after which the window is gone, and that trial
is kept.

| Stage | What it calls |
|---|---|
| `cli` | The program's commands, 30 timed calls each, after one first call that is timed but left out of the percentiles. |
| `names` | The same window under four names, to see which names each mechanism accepts. |
| `production` | `handsExecutor(executorFor(platform), …, 'linux')`: the executor's focus (a `list-windows` check, then `focus-window`), then the built-in xdotool press. |
| `agent-desktop-press` | `pressWithAgentDesktop`: `list-windows`, `focus-window`, then `press`. |
| `press-headless` | `press ctrl+a --app <name>` alone, after one `focus-window`. |
| `press-headed` | `press ctrl+a --app <name> --headed`. |

Percentiles are nearest-rank. The first call of each trial is left out of them and is kept in the raw data (`firstMs` and
`firstPressMs`). In every stage except `names` and `cli` the window's class is set equal to its process name (`python3.12`),
so both the program and the built-in adapter accept one name. The `names` and `cli` stages leave the class as GTK derives
it.

Two sets of runs are kept. The "earlier" pair ran the first four stages with an earlier version of `bench.mjs` that was not
kept. Its settings and output format are the same as the final pair's (`config` in each data file). The "final" pair ran
all six stages. Percentiles for `production` and `agent-desktop-press` pool all four runs. The raw press stages come from
the final pair only. A few short test runs of a few seconds were made while the script was written and were not kept.

## Commands the CLI actually has

The executor originally assumed `focus --app` and `press --app --shortcut`. Neither exists in 1.0.2. The commands used
here are:

- `focus-window --app <name>`: bring the app's window to the front and confirm focus.
- `press <chord> --app <name>`: send a key chord. From the first record, not re-measured here: headless by default, which
  refuses to send keys to a window that is not in front (`STALE_REF`), while `--headed` brings the window forward and sends
  the key through the pointer and keyboard input path.
- `list-apps`, `list-windows`, `status`, `snapshot --app <name> -i`.

Every call prints one JSON envelope with `ok`. Errors exit with status 1.

## Results

### The program's commands

Median / 90th percentile in milliseconds, 30 calls per command per run, final pair. All 30 calls of every command were `ok`
in both runs, and the window survived the stage in both, and in both earlier runs.

| Command | Run 1 | Run 2 |
|---|---|---|
| `status` | 8.2 / 9.5 | 7.8 / 9.5 |
| `list-apps --app` | 21.0 / 27.3 | 21.1 / 22.8 |
| `list-windows --app` | 20.2 / 22.3 | 21.4 / 26.4 |
| `snapshot --app -i` | 27.8 / 30.4 | 30.5 / 38.9 |
| `focus-window --app` | 107.8 / 115.3 | 108.4 / 115.3 |

### Pressing a key

| Path | Trials | Window lost | Calls | Press reported `ok` | Keys logged | Lost at call (range, median among those lost) | Per call, median / p90 (ms) |
|---|---|---|---|---|---|---|---|
| Production: executor focus, then built-in xdotool press | 20 | 0 | 1,200 | 1,200 (focus failed once) | 1,200 | not lost | focus 132.8 / 143.4, press 97.2 / 104.2, together 230.4 / 244.5 |
| Program press with its own focus (`pressWithAgentDesktop`) | 20 | 19 | 328 | 328 | 310 | 3 to 43, median 12 | 178.1 / 191.2 |
| `press`, headless, after one focus | 10 | 9 | 231 | 231 | 222 | 9 to 34, median 20 | 48.9 / 55.2 |
| `press --headed` | 10 | 8 | 279 | 279 | 272 | 1 to 48, median 16.5 | 83.3 / 92.6 |

How to read the table:

- **Window lost** means the test window's process exited. In all 36 cases it exited on SIGSEGV.
- **Calls and keys.** The key count falls short of the call count by the number of calls that killed the window without a
  key being logged: 18 of 19, 9 of 9 and 7 of 8. The other two fatal presses logged their key and then the window died.
- **Per-call times** exclude each trial's first call. "Together" is the focus time plus the press time of the same call, so
  it is not the sum of the two medians. The production focus time includes the executor's `list-windows` check, which is
  why it is above the `focus-window` median in the first table. The program press with its own focus includes the same
  check. The slowest single press in the production stage was 147.7 ms, and the slowest focus was 874.6 ms.
- **By run, for the program press with its own focus.** Earlier pair: 5 of 5 trials lost the window, at calls 22, 10, 4, 5,
  4 in run 1 and 43, 3, 5, 12, 15 in run 2. Final pair: 5 of 5 in run 1 (calls 19, 3, 36, 17, 18), and 4 of 5 in run 2
  (trials 2 to 5, at calls 14, 8, 20, 10; trial 1 made all 60 presses).
- **The one focus failure.** In the production stage's final run 2, trial 3, call 21, the executor's focus step (the
  `list-windows` check and `focus-window`) took 874.6 ms and returned failure. The benchmark pressed anyway, and the key was
  logged. In the product a failed focus ends the run as failed. The cause was not looked into.
- **Production press time.** The press is the built-in adapter's: it activates the window, checks the active window's class,
  and sends the key with `xdotool key`.

### App names

companyOS reads the X11 window class (`WM_CLASS`) of the active window and stores it lower-cased
(`normalizeAppName` in `packages/core/src/classify.ts`), for example `testapp.py`. A focus step on Linux with the program
path set passes that stored name to `focus-window --app`, and the built-in press matches it against the window class
without regard to case. The program matches an app by the name of its process. With the test window's class left as GTK
derives it (`Testapp.py`, process `python3.12`), the `names` stage gave the same ok-or-failed result in all four runs. A
fifth run of that stage alone, with the program's error code kept, is in `names-with-error-codes.json`:

| Name given | Program `focus-window` | Built-in press | Keys logged |
|---|---|---|---|
| `python3.12` (process name) | ok | refused | 0 |
| `Testapp.py` (window class, as the adapter reports it) | `APP_NOT_FOUND` | ok | 1 |
| `testapp.py` (class in lower case, as companyOS stores it) | `APP_NOT_FOUND` | ok | 1 |
| `ADTestApp` (window title) | `APP_NOT_FOUND` | refused | 0 |

A second app gave the same split. One Chromium build (Chrome for Testing, Playwright's `chromium-1243`, started with
`--force-renderer-accessibility`) has the class `Chromium-browser` by `xprop`, and the program's app list names its process
`chrome`. `scripts/agent-desktop-bench/names-probe-chromium.sh` tried five spellings with `focus-window --app`, and its
output is in `names-probe-chromium.txt`: `Chromium-browser`, `chromium` and `Chromium` returned `APP_NOT_FOUND`, and
`chrome` and `Chrome` succeeded, so for that one name the match was not case-sensitive. The built-in press was not tried on
Chromium.

What this means: for both apps tried, the program rejected the stored class name, so the executor's focus step, which passes
that name, would return failure. The production numbers above were taken with a window whose class equals its process name,
so they show speed and survival, not how often the names line up. Two apps is too few to say how common the mismatch is.
Two ways to close it, neither built: fall back to the built-in focus when the program answers `APP_NOT_FOUND`, or find the
process name from the window's `_NET_WM_PID`.

Failure paths measured in the first record, and not re-measured here: a chord that fails the executor's check is refused with
nothing started, a missing app exits with status 1 in about 17 ms, an empty path is reported as `blocked` with nothing
started, and a headless press to a window that is not in front is refused with `STALE_REF` and sends no key.

## Crash in the press path

In all 36 cases the test window's process exited on SIGSEGV, and Python's fault handler reported a fatal error. The earlier
`gdb` run (see the upstream note below) put the fault at `gtk_main_do_event` in libgtk-3. The stack text was not kept for
these runs. It happened only in the press paths: the `status`, `list-*`, `snapshot` and `focus-window` calls did not lose a
window, in the `cli` stage (155 calls per run, four runs, no key sent) or in the 1,200 focus calls of the production stage.
The 1,200 `xdotool` presses of the production stage did not lose one either.

A cause has been proposed upstream in
[vercel-labs/agent-desktop#384](https://github.com/vercel-labs/agent-desktop/pull/384), an open pull request with a proposed
fix. Its author attributes the crash to the short-lived `agent-desktop` process: when the last AT-SPI client leaves the bus
right after a key, at-spi2's ATK bridge in the app removes its key listener while the app may still be inside it. The author
reached this by reading the at-spi2-core source and by timing tests, and did not capture the crash inside that call. Two of
our earlier results, a Python replay that did not crash and a higher rate after killing an earlier window, are not explained
by it. This record did not test the cause. The evidence from the earlier investigation, and our alternative change,
[vercel-labs/agent-desktop#408](https://github.com/vercel-labs/agent-desktop/pull/408) (open; not built or run here), are in
[`agent-desktop-press-crash-upstream-issue.md`](agent-desktop-press-crash-upstream-issue.md). No release has the fix yet, so
none was benchmarked.

## Decision (made 2026-10-31; the choice stands after this re-recording)

- Linux key presses do not go through agent-desktop. They use `xdotool` on X11, which the Linux platform already
  requires, after a check that the app is in front. The supporting numbers are new: 1,200 presses in 20 trials with no
  window lost, instead of 360 presses in six trials, and 36 of 40 trials lost for the program's press, instead of 3 of 3.
  The production path costs about 230 ms for focus and press together (median), against about 178 ms for the program's own
  focus and press, which killed the window in 19 of 20 trials.
- agent-desktop stays optional and off by default. Focus and press on macOS and Windows already have built-in adapters.
  The program is not needed for them and is not enabled by default until it is measured there and its binary is verified.

## Findings

1. **The executor's command shape was wrong in the first version.** It called commands the CLI does not have. This was
   fixed. The unit tests used a fake program, so they could not catch it, and `bench.mjs` now runs the executor against the
   real binary.
2. **Headless press needs focus first.** From the first record: a press to a background window fails, so the executor runs
   `focus-window` before every `press`, which matches the built-in adapters.
3. **Two windows of one app are ambiguous.** Not re-measured. Since the first record the executor refuses a name that
   matches several windows, and its functions accept a window ID (`apps/desktop/src/main/agent-desktop.ts`), though nothing
   in the app passes one yet.
4. **The program's press killed the GTK 3 test window, and returned `ok` for every press that did.** 36 of 40 trials. What
   the runner records for a step like that, through its front-app check, was not tested, because the Linux path does not
   use the program's press.
5. **Linux has a built-in press adapter.** The first record said it did not. Pressing a shortcut on X11 through `xdotool`
   was merged in PR #4.
6. **The two mechanisms name apps differently.** See "App names". With the program path set, a Linux focus step can fail
   because the program does not know the name capture recorded.

## Limits

- Linux on X11, one machine, one GTK 3 test window, and one Chromium name check. Not GNOME, KDE or Wayland. Wayland is the
  newer Linux display system that is replacing X11 on many desktops. companyOS offers no app capture, focus or key press
  there (`platform.ts`), so nothing in this record covers it, and agent-desktop was not tried under it.
- The test window is a plain Python GTK 3 window with the AT-SPI bridge forced on (`GTK_A11Y=atspi`), and no other AT-SPI
  client was on the bus. Other toolkits and real applications may behave differently, and a real desktop has other clients.
  Only the press paths were found to lose it.
- Only the chord `ctrl+a`, 150 ms after each call. The medians of the call at which the window is lost hold for that
  cadence. Trials ran one after another on one bus, each after the previous window was killed or had crashed, which the
  upstream note says raised the crash rate.
- The four runs came from one machine within about 16 minutes, so they are not independent samples. Each press path has 10 to
  20 trials of up to 60 presses, so the medians of the call at which the window is lost are rough.
- The production stage called the executor in a loop, without the runner. The runner, steps closer together than 150 ms, and
  a press followed at once by a program call were not tested. The runner stops at a failed focus, and the loop did not.
- Timings are from a shared virtual machine with a low guest load. They show relative cost, not what a user's machine does.
- `xdotool` is version 3.20160805, the version in Ubuntu 24.04. A newer one was not tried.
- The crash cause was not re-tested. Neither upstream proposal was built or run here.
- The end-to-end suite uses a fake front-app source, so it does not exercise this executor.
- Binary provenance is covered below, with its own limits.

## Reproducing

The scripts are in `scripts/agent-desktop-bench/`. They need the Linux packages `at-spi2-core`, `openbox`, `xvfb`,
`dbus-daemon` (for `dbus-run-session`), `python3-gi`, `gir1.2-gtk-3.0`, `xdotool` and `x11-utils`, plus Node 22 and a built
checkout (`npm run build`). The driver defaults to `/usr/bin/python3.12` for the test window (set `PYTHON`, and `APP_NAME`
if the file's name is not the process name). If you run from a Wayland session, unset `XDG_SESSION_TYPE` first, because
`choosePlatform` offers no Linux adapter when it says `wayland`.

- `run.sh` starts the AT-SPI bus and the window manager and runs `bench.mjs`. Set `AGENT_DESKTOP_BIN` to the binary's path
  and run it under `xvfb-run` and `dbus-run-session`:
  `AGENT_DESKTOP_BIN=… OUT=run.json xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/run.sh`. Set `STAGES`,
  `TRIALS`, `CALLS` or `CLI_CALLS` to run less. Run it on a quiet machine: another busy process changes the timings.
- `testapp.py` is the test window. It needs `KEY_LOG`, the file it logs keys to, which `bench.mjs` sets.
- `names-probe-chromium.sh` is the Chromium name check. It starts its own bus and window manager, needs a Chromium (set
  `CHROMIUM`), and does not need the build.
- The raw results are in `docs/research/agent-desktop-bench-data/`: the four runs with every call (`earlier-run-1.json`,
  `earlier-run-2.json`, `run-1.json`, `run-2.json`), the names stage with error codes (`names-with-error-codes.json`) and
  the Chromium probe output (`names-probe-chromium.txt`).

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
- **macOS and Windows binaries were not run.** They were compared by hash only. Only the Linux x64 binary was started.
- **Later versions.** All of this applies to 1.0.2. A new version needs the same checks.

### What this means for enabling it

The package is traceable to a public workflow and commit, and the binaries we would use match the published release. That
is enough to use it as an optional, user-installed program, which is how companyOS treats it today. It is not enough to
bundle a copy: that needs the release attestation check above, a source review, and a decision on re-signing. Performance
on macOS and Windows is still unmeasured (see Limits).
