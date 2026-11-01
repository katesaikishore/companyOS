# Adapter smoke results: macOS and Windows on hosted runners

Recorded 2026-10-31 on GitHub-hosted runners, branch `adapter-smoke-ci`. Scope: the macOS and Windows adapters in
`apps/desktop/src/main/platform.ts`, and the `agent-desktop` 1.0.2 CLI. Linux is covered elsewhere.

**Status: measured on two hosted machines, not on a person's computer.** Read "What a hosted runner is not" before
trusting any row. Nothing here shows that the first-run permission prompts work, because the runners had the permissions
granted in advance.

## What was run

- **Workflow.** `.github/workflows/adapters.yml`. It runs on `macos-latest` and `windows-latest`. Each job checks out the
  code, installs Node 22, runs `npm ci`, builds the core package and the desktop main process, installs
  `agent-desktop@1.0.2` globally, and runs two scripts.
- **Adapter script.** `scripts/adapter-smoke/smoke.mjs` loads the built `platform.js` and calls `choosePlatform` and
  `executorFor`, the same way the app does. It starts TextEdit (`open -a TextEdit <file>`) or Notepad (`notepad.exe <file>`)
  on a temp file that holds one marker line, then calls `frontmostApp`, `focusApp`, `pressShortcut` and `openFile`.
- **Why a wrapper.** The adapter turns every failure into `false` and drops the error text. The script wraps
  `child_process.execFile` before it loads the adapter, so each command line, exit code and stderr is kept next to the
  call that caused it. The wrapper does not change what the adapter runs.
- **Key delivery check.** A returned `true` does not show that a key reached the app. The script puts a sentinel on the
  clipboard, sends select all, then copy, and reads the clipboard back. If it holds the marker line, both keys arrived.
  Only select all and copy are ever sent. Nothing leaves the test app.
- **CLI script.** `scripts/adapter-smoke/agent-desktop.mjs` runs `status`, `list-apps`, `list-windows`, `focus-window`
  and `press`, three to five times each, and records the JSON the CLI prints, the exit status and the time.
- **Nothing is asserted.** A call that fails is recorded. The jobs stay green. Results go to the job summary and to an
  artifact with the JSON and screenshots.

Runs and what each one was for:

| Run | Event | Purpose and outcome |
|---|---|---|
| 1 `41239878142` | push | First run. macOS gave full data. On Windows, `Start-Process notepad` opened the "Select an app" picker, so no Notepad window existed. |
| 2 `41240387669` | push | Notepad started by full path. Full Windows data. `openFile` with the bare name `notepad` timed out. |
| 3 `41240899704` | push | Variants of the open command. Found the cause (see "Bug 1"). `openFile` returned `true` this time, but opened nothing. |
| 4 `41241432493` | push | Fix for bug 1 in place. |
| 5 `41241580164` | pull_request | Started by pull request 11, which the smoke-test work did not open. Same code as run 4. Not used. |
| 6 `41241927662` | push | Clean single-window TextEdit data. Found bug 2. |
| 7 `41241931352` | pull_request | Same code as run 6. The tables below come from this run. |
| 8 `41242508087` | pull_request | Fix for bug 2 in place. See "After the fix". |
| 9 `41243038529` | pull_request | Started by pushing this results document while pull request 11 was open, on branch head `b9bbf4d`. No tables here come from it. |

A pull-request run checks out the merge of the branch into `main`, so run 7 ran on commit `293d7b1`, not on the branch
head `cbfd3ed`. The files under test are the same.

## What a hosted runner is not

- **macOS permissions were granted in advance.** The system and user TCC databases already allow Accessibility and
  Automation for `/usr/bin/osascript` and `/bin/bash` (`kTCCServiceAccessibility|/usr/bin/osascript|2|0`, where `2` is
  allowed). The first-run prompt, the denied state, and the error text for a denied call were never seen. The app's
  wording for those cases is unchecked.
- **Windows ran elevated, as an administrator.** User `runneradmin`, session 2 on the console, 1024x768. Whether UAC was on was not recorded. A normal
  user's SendKeys into an elevated window is the case the adapter comment warns about. It could not occur here.
- **One machine type each.** macOS 26.6.2 on Apple Silicon (arm64). Windows Server 2025 Datacenter, build 26100, x64,
  Windows PowerShell 5.1. Intel Macs, older macOS, Windows 10, Windows 11 and Windows on Arm were not tested.
- **The macOS image changed between runs.** Run 1 used image `20261021.0445.8`. Run 7 used `20261026.0455.2`.
- **A small, quiet desktop.** One display, no other user, no antivirus prompts, no other open apps, no locked screen.
- **Git for Windows is on the PATH.** That is how bug 1 appeared. Many developer machines have it. Many other
  machines do not.

## macOS

Runner image `macos26` 20261026.0455.2, macOS 26.6.2, arm64. Session manager `Aqua`, user `runner`, Finder and
WindowServer running. TextEdit had one window. Source: run 7.

### The adapter (`platform.ts`)

Times are minimum / median / maximum over the calls in that row.

| Call | Result | Front app afterwards | Error text | Time |
|---|---|---|---|---|
| `frontmost()` | `Finder`, then `TextEdit` after it came forward | | none | 87 / 105 / 141 ms (8 calls, not counting the first one, made before the test app launched) |
| `focus('Finder')` while TextEdit in front | `true` | Finder | none | 100 ms (1 call) |
| `pressShortcut('TextEdit', 'cmd+a')`, Finder in front | `true` | TextEdit | none | 596 ms (1 call) |
| `focus('TextEdit')`, Finder in front | `true` | TextEdit | none | 58 / 73 / 79 ms (3 calls) |
| `pressShortcut('TextEdit', 'cmd+a')`, TextEdit in front | `true` | TextEdit | none | 116 / 125 / 126 ms (3 calls) |
| `pressShortcut` select all, then copy | `true`, `true` | TextEdit | none | 102 and 140 ms |
| `openFile('TextEdit', file)` | `true` | TextEdit | none | 51 ms (1 call) |
| `focus('TwinNoSuchApp')` | `false` | | `osascript exit 1: execution error: Error: Error: Application can't be found. (-2700)` | 47 ms |
| `pressShortcut('TwinNoSuchApp', 'cmd+a')` | `false` | | same `-2700` error | 23 ms |
| `pressShortcut('TextEdit', 'cmd+notakey')` | `false` | | none: refused before any program starts | 0 ms |

What the data shows:

- All four adapter calls did what they claim, on this machine. After each focus the front app was TextEdit. Each
  `pressShortcut` left TextEdit in front.
- **Keys reached the app.** After select all and copy, the clipboard held the marker line instead of the sentinel.
- `openFile` returned `true`. The file was already open, so the TextEdit window count stayed at 1. This does not show
  that a closed file would open.
- Run 6, with the same code, gave the same results. Times varied: the first `pressShortcut` from another app took
  1256 ms in run 6, 596 ms in run 7 and 2518 ms in run 4. The adapter waits for the app to report frontmost, so it
  is the slowest call when the app is behind.

### The `agent-desktop` CLI

Binary `agent-desktop-darwin-arm64`, 3,741,392 bytes, SHA-256 `bf0a3c92...ba59`. Source: run 7. `focus-window` and `press`
were called with Finder in front.

| Command | Exit codes | Result | Time |
|---|---|---|---|
| `status` | 0,0,0,0,0 | ok. Accessibility, Automation and Screen Recording all `granted` | 15 / 15 / 22 ms (5 calls) |
| `list-apps` | 0,0,0,0,0 | ok | 85 / 90 / 105 ms (5 calls) |
| `list-windows --app TextEdit` | 0,0,0,0,0 | ok, 1 window | 43 / 50 / 53 ms (5 calls) |
| `focus-window --app TextEdit` | 0,0,0 | ok. Front app went from Finder to TextEdit each time | 196 / 211 / 226 ms (3 calls) |
| `focus-window --app TwinNoSuchApp` | 1,1,1 | `APP_NOT_FOUND` | 23 / 25 / 26 ms (3 calls) |
| `press cmd+a --app TextEdit`, after `focus-window` | 0,0,0 | ok, `delivered_unverified` | 139 / 168 / 173 ms (3 calls) |

Key delivery, by the clipboard check:

| Variant | Exit codes | Front before and after | Keys reached the app |
|---|---|---|---|
| `focus-window`, then `press` | 0,0,0 | Finder, TextEdit | yes |
| `press` only, Finder in front | 0,0 | Finder, Finder | **no**. The clipboard still held the sentinel. |
| `press --headed`, Finder in front | 0,0 | Finder, TextEdit | yes |

- **A headless `press` to a background app reports success and delivers nothing.** The CLI answers `ok: true` and
  `delivery: delivered_unverified` through `CGEventPostToPid`. The keys did not arrive in three runs (6, 7 and 8). The wording
  "unverified" is accurate. A caller that treats exit 0 as success would be wrong. The executor always calls
  `focus-window` first, which is the case that worked.
- **Two windows of one app block a focus by name.** In runs 1 to 4, TextEdit had two windows with the same title. They were most
  likely restored from the previous script's launch. `focus-window --app TextEdit` exited 1 with `AMBIGUOUS_TARGET` in 12 of 12 timed calls.
  The reply lists both window IDs and suggests `--window-id`. This is the refusal the executor expects.
  The test scripts now delete the temp file after a run, and runs 6 and 7 had one window.
- **The binary is ad-hoc signed and not notarized.** `codesign -dvv` shows `Signature=adhoc`, linker-signed, no team
  identifier. `codesign --verify` passes. `spctl --assess --type execute` exits 3 with `rejected`. The file had no
  quarantine attribute, because npm wrote it. A copy downloaded with a browser would be quarantined, and Gatekeeper
  would reject it.

## Windows

Runner image `win25-vs2026` 20261021.278.1, Windows Server 2025 Datacenter, build 26100, x64. User `runneradmin`
(administrator), session 2 on the console, `UserInteractive` true, virtual screen 1024x768, Windows PowerShell 5.1.
Notepad had one window. Source: run 7.

### The adapter (`platform.ts`)

| Call | Result | Front app afterwards | Error text | Time |
|---|---|---|---|---|
| `frontmost()` | `WindowsTerminal`, `mspaint`, `notepad`, each correct when read | | none | 365 / 529 / 1349 ms (8 calls, not counting the first one, made before the test app launched; the `WindowsTerminal` result is from that first call) |
| `focus('mspaint')` | `true` | mspaint | none | 362 ms (1 call) |
| `pressShortcut('notepad', 'cmd+a')`, mspaint in front | `true` | notepad | none | 497 ms (1 call) |
| `focus('notepad')`, Notepad **minimized** | **`false`** | mspaint | `powershell.exe exit 3` (AppActivate returned false). No other text. | 321 / 339 / 362 ms (3 calls) |
| `pressShortcut('notepad', 'cmd+a')`, Notepad in front | `true` | notepad | none | 573 / 778 / 898 ms (3 calls) |
| `pressShortcut` select all, then copy | `true`, `true` | notepad | none | 700 and 668 ms |
| `openFile('notepad', file)` (with the fix for bug 1) | `true`, a second Notepad window opened | notepad | none | 289 ms (1 call) |
| `focus('TwinNoSuchApp')` | `false` | | `powershell.exe exit 2` (not running) | 436 ms |
| `pressShortcut('TwinNoSuchApp', 'cmd+a')` | `false` | | `powershell.exe exit 2` | 317 ms |
| `pressShortcut('notepad', 'cmd+notakey')` | `false` | | none: refused before any program starts | 0 ms |

What the data shows:

- `pressShortcut` brought Notepad forward from another app, waited for it, and sent the keys. After select all and copy
  the clipboard held the marker line (`twin-smoke-marker-7f3a`). **Keys reached the app.**
- `focus` can move the front app (Notepad to Paint, and Paint to Notepad through `pressShortcut`).
- **`focus` failed for a minimized window**, three of three times, in runs 6 and 7. The same sequence run by the
  test script (restore the window, then `AppActivate`) put Notepad in front three of three times. See "Bug 2".
- Every adapter call starts a new PowerShell. `frontmost()` took about 0.4 to 0.5 s, and once 1.3 s. A key press took
  about 0.6 to 0.9 s. Run 6 had the same results. Its medians differed from run 7 by up to about 35%.
- The exit codes 2 and 3 carry the reason, and the adapter drops them. The adapter returns only `false`.

### The `agent-desktop` CLI

Binary `agent-desktop-win32-x64.exe`, 3,464,704 bytes, SHA-256 `409e58cb...3988`. Source: run 7. `focus-window` and
`press` were called with Paint in front.

| Command | Exit codes | Result | Time |
|---|---|---|---|
| `status` | 0,0,0,0,0 | ok. Accessibility `granted`, Automation and Screen Recording `not_required` | 43 / 43 / 77 ms (5 calls) |
| `list-apps` | 0,0,0,0,0 | ok. Names carry `.exe`, for example `notepad.exe` | 21 / 22 / 23 ms (5 calls) |
| `list-windows --app notepad.exe` | 0,0,0,0,0 | ok, 1 window | 26 / 27 / 27 ms (5 calls) |
| `focus-window --app notepad.exe` | 0,0,0 | ok. Front app went from mspaint to notepad each time | 146 / 146 / 148 ms (3 calls) |
| `focus-window --app TwinNoSuchApp` | 1,1,1 | `WINDOW_NOT_FOUND` | 50 / 50 / 51 ms (3 calls) |
| `press ctrl+a --app notepad.exe`, after `focus-window` | 0,0,0 | ok | 53 / 53 / 55 ms (3 calls) |

Key delivery, by the clipboard check:

| Variant | Exit codes | Front before and after | Keys reached the app |
|---|---|---|---|
| `focus-window`, then `press` | 0,0,0 | mspaint, notepad | yes |
| `press` only, Paint in front | 1,1 | mspaint, mspaint | no. `ACTION_FAILED`: "Target application is not foreground; Windows SendInput cannot deliver to a background process" |
| `press --headed`, Paint in front | 0,0 | mspaint, notepad | yes |

- **On Windows a headless `press` to a background app fails loudly.** This is the safe behavior. It differs from
  macOS, where the same call reports success.
- **The names `notepad.exe`, `Notepad` and `notepad` all matched the one Notepad window** with `list-windows`. A name that
  matches nothing also exits 0, with an empty list. A caller must read the list.
- **The binary is not signed.** `Get-AuthenticodeSignature` reports `NotSigned`.
- The `.sha256` files that ship in the package match the binaries on both systems. That shows the package is
  consistent with itself. It does not show that the binaries are the upstream project's builds.

## Bugs found, and what changed

### Bug 1: `openFile` and `openUrl` with a bare name opened the wrong thing on Windows

- **Seen.** Run 1: `Start-Process -FilePath notepad` showed the "Select an app to open 'notepad'" picker. Run 2: the
  adapter's `openFile('notepad', file)` ran for the full 4 s timeout and returned `false`. Run 3: the same call returned
  `true`. A picker was on screen afterwards and the Notepad process count had not changed, so no file opened. The
  `true` was wrong.
- **Cause.** The runner has a file named `notepad`, with no extension, at `C:\Program Files\Git\usr\bin\notepad`. That
  folder is on the PATH. The shell takes the bare name `notepad` to be that file, which has no program registered, so it
  asks which app to use. `Get-Command notepad -All` lists the extensionless file first.
- **Variants run in runs 3, 4, 6, 7 and 8.** With the same `Start-Process` form as the adapter: `notepad.exe` opened Notepad
  and showed no picker. The full path `C:\Windows\System32\notepad.exe` did the same. The bare name `notepad` showed
  the picker in runs 4, 6 and 7, from both the repository folder and `C:\Windows\Temp`. Run 3 cannot be read: a picker
  left on screen by the earlier `openFile` call was already there, so `pickerShown` was true even after the `notepad.exe` variant. The call sometimes returned in about
  0.4 s and sometimes did not return within 8 s. So the working directory is not the cause.
- **Fix.** `windowsProgram()` in `platform.ts` adds `.exe` to a bare name, and leaves a name with an extension or a path
  alone. It applies only to `openFile` and `openUrl`. Focus and press match on the process name and are unchanged.
  Unit tests: `apps/desktop/test/windows-open.test.ts`.
- **Checked on the runner.** After the fix, `openFile('notepad', file)` took the Notepad process count from 1 to 2 and
  showed no picker (run 7: before 1, after 2, `pickerShown` false).
- **Not checked.** `openUrl` was never called on either system. It uses the same `Start-Process` form on Windows and
  `open -a` on macOS. A name with spaces, such as `Google Chrome`, would now become `Google Chrome.exe`. Whether such a name opened
  before was not tested.
- **Left as it is.** `openFile` returns `true` when `Start-Process` returns, not when a file opens. The false `true`
  in run 3 shows the gap. Closing it needs a check that a window appeared, which is not done.

### Bug 2: `focus` and `pressShortcut` failed for a minimized Windows window

- **Seen.** Runs 6 and 7: with Notepad minimized, `focus('notepad')` returned `false` three of three times, and the
  front app stayed Paint. The script exit code was 3, from `AppActivate` returning false.
- **Cause.** `AppActivate` returned false for the minimized window and true after the window was restored. That fits
  `AppActivate` not restoring a minimized window. Nothing else was varied.
- **Evidence for the fix.** In both runs, the test script restored the window with `ShowWindowAsync(handle, 9)`, then
  called `AppActivate` again. Notepad came to the front three of three times.
- **Change.** `WIN_FOCUS` and `WIN_PRESS` call `AppActivate` first, as before. Only if it fails and the window is
  minimized (`IsIconic`), they restore the window, wait 300 ms and try once more. A window that is not minimized
  is never touched, and a successful first call costs nothing extra. `pressShortcut` had the same exit code 3 path, so it
  got the same change. Unit tests check the order of the steps in both scripts.
  They cannot run PowerShell, so the behavior is checked only by the workflow.

## After the fix

Run 8 (`41242508087`, pull request, branch head `ec1f546`, merged commit `61e06ec`) ran with both fixes. The Windows
runner was a different machine from run 7 (`1000001377`, same image).

| Call on Windows | Before (run 7) | After (run 8) |
|---|---|---|
| `focus('notepad')`, Notepad minimized | `false` three times, exit 3, Paint stayed in front, 321 / 339 / 362 ms | `true` three times, Notepad in front, 780 / 784 / 788 ms |
| `pressShortcut('notepad', 'cmd+a')`, Notepad minimized | not run | `true`, Notepad in front, 865 ms (1 call) |
| `openFile('notepad', file)` | Notepad processes 1 to 2, no picker | the same, 292 ms |
| `pressShortcut` select all, then copy | clipboard held the marker line | the same |
| `focus` and `pressShortcut` to a program that is not running | `false`, exit 2 | the same |

- The fix cost about 0.4 s on the call that needed it, compared with the failing call in run 7. A call whose first
  `AppActivate` succeeds takes the same path as before.
- Whether a key reaches a window that was minimized was not checked on its own. The minimized press returned `true` and
  Notepad was in front afterwards. The clipboard check ran only with Notepad already in front.
- The macOS adapter rows in run 8 matched run 7. The macOS code did not change. The CLI delivery results matched too:
  a headless `press` to a background app reported success and the clipboard stayed unchanged, in runs 6, 7 and 8.

## Not verified

These need a real machine, or a different setup. None of them can be tested on a hosted runner.

- **macOS permission prompts and denied permissions.** The runners had Accessibility and Automation granted. The
  prompt wording, the denied error text and the return values for a denied call are unknown.
- **A normal, non-elevated Windows user** pressing keys into an elevated window, and the UAC behavior around it.
- **Windows 10, Windows 11, Windows on Arm, Intel Macs, older macOS.** One image of each was tested.
- **Real apps.** Only TextEdit, Notepad and Paint. Browsers, Electron apps, apps with several windows, full-screen apps,
  Stage Manager, virtual desktops, a locked screen and several monitors are untested.
- **`openUrl` on both systems**, and `openFile` for a file that was not already open on macOS.
- **Binary provenance of `agent-desktop`.** The SHA-256 values above are for the npm package. They were not compared with
  the upstream release files or signatures.
- **Behavior over time.** One run of each job per code version, a few calls per row. Times varied by up to a factor of two
  between runs of the same code. Treat them as a rough scale.

## Re-running

The workflow runs on a pull request that changes `platform.ts`, `keys.ts`, the workflow or `scripts/adapter-smoke`. After it is
on the default branch it can also be started from the Actions tab (`workflow_dispatch`). Each job uploads
`adapter-smoke-<os>` with the JSON, a Markdown summary and screenshots. The job log holds the full JSON in a collapsed group.
