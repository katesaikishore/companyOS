# Input steps: proposal for typing, clicking and sending

Status: proposal only. No code. Written 2026-10-31 against `origin/main` (3087e81).

This is about three step types that do not exist yet: typing text, clicking an element, and sending a message. It also has a short section on what Wayland allows (section 12). Level 5 is a separate proposal: [l5-outbox-proposal.md](./l5-outbox-proposal.md).

Sources: `docs/plan/README.md` §5.3, §7.1 to §7.5, §13. `docs/research/os-capture.md` (the Linux notes and the capability matrix). `docs/research/l5-outbox-proposal.md`. Code read: `packages/core/src/automation.ts`, `policy.ts`, `classify.ts`, `runner.ts`, `autonomy.ts`, `types.ts`, `apps/desktop/src/main/platform.ts`, `apps/desktop/src/main/index.ts` (the approval dialog).

## 1. Summary

Typing, clicking and sending are the first steps whose effect the twin cannot check. A key press goes to whatever control has focus. A click acts on whatever is under the pointer or on the named element. A send cannot be taken back. Because of that, this proposal makes them stricter than the open and key steps that exist today.

Recommendations:

- **Build them only as supervised, level 3 steps.** Each one asks the person, every run, with the exact text or element shown. None runs unattended, and none can lift an automation to level 4.
- **Classify all three as `external_effect`.** Do not try to sort them into local and external by app. The twin cannot see where the keys land.
- **Accept literal text only.** No text from the screen, from a web page or from a model. This keeps the Rule of Two (plan §7.4) true by construction.
- **Refuse newlines, tabs and other control characters in typed text.** A newline typed into a chat app sends the message. Sending must be its own step, so it gets its own approval.
- **Keep text out of every record.** Run history, logs, the ledger, errors and process arguments never hold typed text.
- **Click by accessibility role and name, not by screen coordinates.**
- **Leave browsers to the DOM tier.** Typing and clicking in a browser go through the extension (plan §7.2, tier 3), not through key and mouse injection.

Section 13 lists the decisions the owner has to make before any of this is built.

## 2. What exists today

- Five step ops: `focus_app`, `check_focus`, `open_url`, `open_file`, `press_shortcut`. Each is a strict schema with its own checks (`automation.ts`).
- `effectOfOp` returns `external_effect` for the open and press steps, because their outcome is not visible (`classify.ts`). `FLOOR_EFFECTS` always need a present person (`types.ts`).
- `open_file` already has the rule this proposal reuses: it always asks, and it is denied when unattended (`policy.ts`).
- The promotion gate to level 4 requires that every effect is `read_only` or `local_reversible` (`autonomy.ts`, `LOCAL_EFFECTS`). An `external_effect` step therefore blocks promotion with no new code.
- The runner asks before an open or key step, then runs it, then checks that the expected app is in front (`runner.ts`). The approval dialog takes focus, so the key adapters bring the app forward again and check before they send anything (`platform.ts`, `pressShortcut`). Input steps need the same.
- The approval is a native Electron message box built from `describeStep`. It names the exact address, file or chord. Page content cannot change it (`index.ts`, `approveStep`).
- The network ledger lists the twin's own calls: model downloads and update checks (`NetworkEntry`). It does not list anything an app sends.
- Capture never records key contents (plan §5.3, `os-capture.md`). So mined routines never contain typed text, and a typing step can only come from something the owner writes.
- The key adapters exist on macOS (System Events), Windows (`SendKeys`) and X11 (`xdotool key`). The macOS and Windows ones have not run on a real machine.

## 3. The steps

All three name an application, like the existing steps. A shell, a script runner or a terminal is refused as the app, as for `open_file`. So is an app on the exclusion list.

| Op | Fields | What it does |
| --- | --- | --- |
| `type_text` | `app`, `text` | Brings the app forward, checks it is in front, types the text as key presses. |
| `click_element` | `app`, `role`, `name` | Brings the app forward, finds one element with that role and name in its accessibility tree, and activates it. |
| `send` | `app`, `how` | Submits what is in the app's message box. `how` is a key chord (`cmd+return`, `ctrl+return`, `return`) or one named button. |

Rules for the fields:

- **`text`** is 1 to 200 characters, normalised to NFC. It may use `$pN` only where the parameter's approved options are texts that pass the same rules. It holds no control characters (Unicode `Cc`), no format characters (`Cf`, which covers zero-width and bidirectional overrides), no tab and no newline. It is stored literally in the sealed automation, like a URL or a path today.
- **`role` and `name`** come from the accessibility tree. A step names exactly one element. If the tree has none or more than one, the step is refused and nothing is clicked.
- **`send`** is allowed only in an app classified as mail or chat. It is a separate op so the policy, the dialog and the log can tell a send from a click.
- No step accepts a pixel coordinate in this version (decision I8).
- An automation with these steps has at most 12 steps, as now. A run may type at most 500 characters in total (decision I7).

Typing is never done by pasting. The clipboard is not used, so its contents are neither read nor overwritten.

## 4. Effect classes and policy

### 4.1 Effect classes

| Op | Class | Why |
| --- | --- | --- |
| `type_text` | `external_effect` | The twin cannot see which control has focus. Text can reach a web form, a chat box or an app that acts on typed characters. |
| `click_element` | `external_effect` | A click can press Send, Buy or Delete. |
| `send` | `external_effect`, marked as cannot be undone | Messages leave the device. The class list has no reversibility field. The L5 proposal adds one (`l5-outbox-proposal.md` §4.1). |

A classifier may raise a class and never lower one. For example, a clicked element whose name matches a fixed list (delete, remove, pay, buy, purchase, install, grant, allow) is classed `deletion`, `money`, `install` or `permission`. Those are floor effects too, so the decision does not change, but the dialog and the record say which kind it is. The list is a hint for labels. It is not a safety control, because names can be anything.

### 4.2 Policy rules

Evaluated in `evaluateStep`, as ordinary code before every step:

1. **Always ask, per run, per step.** A person approves each step. One approval does not cover a later step or a later run.
2. **Never unattended.** When `unattended` is true the step is denied, with the same wording as `open_file`: it needs a person to approve that exact step.
3. **Level 2 and below deny.** A draft is shown, not run. Level 5 stays denied (`policy.ts`).
4. **No promotion.** An automation with any of these steps cannot reach level 4, because the gate needs local and reversible effects. A test should pin this (section 10).
5. **Allowed targets.** The app is not a shell or terminal, is not excluded, and for `type_text` and `click_element` is not classified `browser` (decision I3). For `send` it is classified `mail` or `chat`.
6. **App in front.** The adapter sends nothing unless the named app is in front at that moment. If the check fails, nothing is sent and the step fails.
7. **No secret fields.** The adapter refuses to type when the focused control is a password field, where the platform can say so (section 8, decision I5).
8. **Stop switch.** The runner reads the stop flag before each step. An adapter that types in chunks reads it between chunks.
9. **No automatic retry.** A failed input step stops the run. A retry could type the text twice or send twice. This matches the L5 rule that an unknown outcome is never retried (`l5-outbox-proposal.md` §4.2).
10. **No text from untrusted sources.** The schema takes literal text only. No step may take its text from a screen, a page, a message or a model.

Level 5 is not in this proposal. If it is ever built, a `send` would go through the outbox described in [l5-outbox-proposal.md](./l5-outbox-proposal.md), with its countdown, preview and approval rules. Until then `send` is level 3 only.

## 5. The approval dialog

The dialog is the existing native message box. It is built only from the validated step, never from the screen or from a model.

What it shows:

- **Type.** `Type this text in "Notes"?` Then the text in full, in a monospace block, with its length: `23 characters`. The text is never cut. The 200 character cap means it always fits. If the text has characters outside ASCII, the dialog says how many, so look-alike letters are not hidden.
- **Click.** `Click the button "Save" in "Notes"?` with the role and the name.
- **Send.** `Send the message in "Slack" now?` with how: `Press cmd+return` or `Click the button "Send"`. A line says: `A sent message cannot be taken back.`
- **Always.** The target app, and one line: `Typed as key presses. The clipboard is not used.` The default button is "Stop the run".

What it never shows:

- the clipboard;
- a screenshot or any image of the screen;
- a window title, or text read from the target app (such as a preview of the message). The twin does not read content from other apps (plan §5.3). The person can see their own screen.

The twin's dialog takes focus. After "Allow", the adapter brings the target app forward again and checks before it types. This is the same pattern as the key press adapters.

## 6. Redaction

Typed text and element names are content. The rules:

- **Stored once, sealed.** The text lives only in the automation definition, in the encrypted store, like a URL or a path.
- **Run history keeps** the op, the app, the outcome, and for typing the character count. It never keeps the text, the element name or the role. `StepRecord` has no field for them and should not get one.
- **Logs and diagnostics** never hold text or names. Adapter errors are not surfaced, because they can carry the command (existing practice in `platform.ts`). Only a `StepRefusedError` message is shown, and it carries no text.
- **Never on a command line.** On Linux, `/proc/<pid>/cmdline` is readable by every user (mode 0444, checked here). `/proc/<pid>/environ` is not (mode 0400). Text goes to the adapter on stdin or through the environment, as the Windows adapter already does for chords. It never goes in an argument.
- **Never in export or egress.** MCP export, company aggregates and any future upload carry counts at most. Section 10 adds a canary test for this.
- **Never mined.** The miner works from focus events. It cannot produce a typing step.
- **Secrets.** The authoring view warns when text matches the secret patterns in plan §5.3 (card numbers, keys). Typing a password is out of scope. Credentials come from the keychain through a separate design (plan §7.5).

## 7. The network ledger

The ledger answers "what did the twin send?" Input steps make no network call from the twin, so typing and clicking add nothing to it.

A `send` is different. The twin does not send the message, but it causes an app to send one, and the person looks at the ledger page to learn what left the machine. Recommended (decision I10): keep the ledger's meaning, and add a second table on the same page, "Sent through apps". Each row has the time, the automation name, the app and the outcome. It has no recipient, no text and no length, because the twin does not see them. The table is labelled as what the twin did, not what the app sent.

The alternative is a new `purpose` value in `NetworkEntry`. It mixes two meanings in one list, and it needs a store migration for existing ledgers. Not recommended.

## 8. Adapters

Each adapter is a function in `platform.ts` with the same shape as `pressShortcut`: bring the app forward, check it is in front, then act. Arguments are arrays. There is no shell. Text goes through stdin or the environment. A timeout applies to every call. Output and error text are not kept.

What was run for this proposal: on Linux, `xdotool type --file -` read a text from stdin and typed it into an xterm under Xvfb and Openbox, character for character. The text held a `$(id)` command substitution, double quotes and backticks. Nothing else here was run. The macOS and Windows notes come from vendor documentation and from how the existing key adapters work. They need testing on real machines (section 10).

### 8.1 macOS

- **Type.** System Events `keystroke`, as `pressShortcut` uses. Alternatively Quartz keyboard events with a Unicode string, which do not depend on the keyboard layout. The text goes in the environment, not the script. Both need the Accessibility permission, in addition to the Automation permission the app asks for now (decision I9).
- **Secure fields.** If Secure Event Input is on, the adapter refuses. The check needs a native call or the Objective-C bridge. Not tested.
- **Click.** Find the element through the accessibility tree and perform its press action. This needs no coordinates. Quartz mouse events are the fallback and are not proposed (decision I8).
- **Send.** The chord through the same path as `pressShortcut`, or a click on the named button.

### 8.2 Windows

- **Type.** `SendInput` with `KEYEVENTF_UNICODE`, one UTF-16 unit at a time, through the same PowerShell and `Add-Type` pattern as the existing adapters. The text goes in an environment variable. `SendKeys` is not used for text, because it reads `+ ^ % ~ ( ) { } [ ]` as commands.
- **Elevated windows.** Windows blocks input into a window at a higher integrity level. The documentation says the call can fail without an error that names the cause. The adapter cannot tell, so the step needs a check that the app is still in front, and it cannot promise the keys arrived.
- **Secure fields.** UI Automation `IsPassword` on the focused element.
- **Click.** UI Automation: find the element by role and name, then use its Invoke pattern. No coordinates.
- **Send.** A chord through `SendInput`, or Invoke on the named button.

### 8.3 Linux on X11

- **Type.** `xdotool type --clearmodifiers --delay N --file -`, with the text on stdin. It goes through XTEST, like the existing `xdotool key` path. `--window` is not used. It sends the keys with XSendEvent instead of XTEST, and many apps are known to ignore those events (not tested here). The app check is the same as for presses: activate, then compare the active window with the app's windows.
- **No isolation on X11.** Any other program in the same X session can read keystrokes. Typed text on X11 is not private from them. This is a property of X11, and the dialog cannot fix it.
- **Secure fields.** X11 does not say which control is a password field. That needs AT-SPI, which is not built. Decision I5 is whether to block typing on X11 until it is.
- **Click.** Element clicks need AT-SPI and are not available on X11 now. xdotool can click at coordinates, which this proposal excludes.
- **Send.** A chord through `xdotool key`, as `pressShortcut` does.

## 9. Failure modes

| Failure | What happens | Mitigation |
| --- | --- | --- |
| Focus moves between the check and the first key | Text goes to the wrong app | Check right before sending. Type in short chunks and check between them where the adapter loops. A single-call adapter (`osascript`, one `xdotool` call) can only check before. |
| The right app is in front, but the wrong field has focus | Text goes to the wrong field | Cannot be seen from outside. This is why the class is `external_effect` and the person approves each run. |
| Newline or tab in text | A form or chat sends, or focus moves | The schema refuses both. Return is a `send` step. |
| IME or keyboard layout | Wrong characters | Use Unicode key events on macOS and Windows. On X11 xdotool remaps keys for characters the layout lacks, which is a known weak point (not tested here). Test with non-ASCII text. |
| Autocomplete or auto-correct | The app changes the text | Cannot be seen. Not solved here. Read-back would show it (decision I11). |
| Apps drop keys when typing fast | Text is short | A delay setting and a count check where the platform allows. No read-back, so a drop is not detected. |
| Password field in focus | A secret is typed, or the step types into a field meant for a secret | Refuse where the platform can say so. Not possible on X11 today. |
| Permission missing (macOS Accessibility) | The call fails, or keys are dropped | Check the permission at the start of the run. Block with a reason, do not fail. |
| Elevated target on Windows | Keys silently do not arrive | The in-front check, plus a note in the result that arrival is not confirmed. |
| Stop pressed while typing | Part of the text is typed | Stop between chunks. Already typed text cannot be recalled. Say so in the result. |
| Run crashes or the app hangs mid-step | Unknown state | Record the step as started before it runs. An unfinished step is shown as unknown. Never retry automatically. |
| Duplicate send | The message goes twice | No retry. One approval covers one send. |
| Prompt injection from a page or message | A step is changed | The schema takes no text from the screen. Steps are fixed before any content is read (plan §7.5). |

## 10. Test plan

Unit tests in `packages/core`:

- The schemas: every op is strict. Text rules: length, NFC, control and format characters, tab, newline, bidirectional overrides, zero-width characters. Element fields. `how` for a send.
- A policy table over level (0 to 5), unattended, and app class, for each op. Every cell is `ask` or `deny`, never `allow`.
- A promotion test: an automation with each op never passes the level 4 gate.
- `describeStep` shows the full text and the target, and has no clipboard or image wording.
- Run records have no text, name or role. A type check on `StepRecord` fails if a field for them is added.

Adapter tests in `apps/desktop`, with fakes on `PATH`, as `linux-press.test.ts` and `linux-open.test.ts` do:

- The fake `xdotool` records its arguments and stdin. Text is never in an argument. Text with `$`, quotes, backticks, `%`, `;`, and non-ASCII arrives unchanged on stdin.
- Nothing is sent when another window is active, when the app has no window, when activation fails, or when the text fails the schema.
- The stop flag between chunks.
- No retry after a failure.

Privacy canary tests in `tests/privacy`: add a canary string as typed text. After a run with a fake adapter, assert that it appears in no event, run record, ledger entry, log line, error text or export.

Real-machine tests:

- Linux: a run under Xvfb and Openbox with a stand-in app that records the keys it gets, as was done for the open steps. Includes the secure-field gap, which should show as "not detected".
- macOS and Windows: the hosted-runner smoke work (`adapter-smoke-ci`) is the starting point. A hosted macOS runner may not allow Accessibility. If it does not, these adapters stay untested until someone runs them on a real machine. The doc and the release notes should say that.

Review gates before any of this ships: the privacy canary tests pass, every cell in the policy table is `ask` or `deny`, and the macOS and Windows adapters have run on real machines with the Accessibility and UIPI cases.

## 11. Level 5

Not covered here. An unattended or automatic send needs the outbox: a queue, a countdown the owner can cancel, a preview that matches the sent bytes, a kill switch that covers queued items, and a promotion gate that the plan does not have yet. All of that is in [l5-outbox-proposal.md](./l5-outbox-proposal.md). Nothing in this proposal lets a `send` run without a present person.

## 12. Wayland: what is feasible

Today the app refuses all capture on Wayland. This section says what could change that. Nothing here was run: the build container has no Wayland compositor. The facts come from `os-capture.md` (research notes) and from the portal and protocol documentation, and they need testing on each compositor.

### 12.1 Capture

Wayland has no global window or input introspection by design. Each compositor needs its own path.

| Need | Path | Notes |
| --- | --- | --- |
| Front app and window | wlroots, Hyprland, COSMIC: `wlr-foreign-toplevel-management` (title, app id, activated state) | Not available in GNOME or KDE. |
| | KDE: a bundled KWin script that reports over D-Bus | One script to maintain. |
| | GNOME: a shell extension | Breaks across GNOME major versions. |
| | `ext-foreign-toplevel-list` | Support in Mutter and KWin is unconfirmed in the research notes. |
| Idle time | `ext-idle-notify-v1`, or `org.gnome.Mutter.IdleMonitor` on GNOME | |
| Focused element and text | AT-SPI2 | Works under Wayland for GTK and Qt. Electron and Chromium need accessibility turned on. Not built. |
| Pixels | ScreenCast portal (PipeWire) or the Screenshot portal | The person picks the source. A ScreenCast session can be restored with a token. Both show consent. Screenshots are off by default in this product. |
| Keyboard and mouse monitoring | None | The InputCapture portal is for pointer barriers, not monitoring. Reading `/dev/input` needs the `input` group, which is a keylogger. Rejected. |

Sandboxed builds (Flatpak, Snap, AppImage) cannot read activity under Wayland, per the research notes. The `.deb` and `.rpm` route stays.

### 12.2 Key input

The plan names one route (§7.2): libei through the `xdg-desktop-portal` RemoteDesktop portal, on GNOME 46 and later and KDE 6, with X11 XTest as the fallback. It rejects `ydotool` and `uinput` because they skip consent.

- **How it works.** The app opens a RemoteDesktop session, asks for keyboard and pointer devices, and the compositor shows a consent dialog. After consent the app can send keys. Either it calls the portal's notify methods directly, or it asks the portal for an EIS socket and speaks libei. A restore token can keep consent between runs. This needs checking on each compositor.
- **Text.** libei sends key codes, which depend on the layout. The keysym notify method lets the compositor do the mapping, which suits text better. Characters outside the current layout are a risk and need tests.
- **Consent is part of the design.** This fits "always ask". It also means a consent dialog from the system on top of the twin's own approval. Decision I13 is whether that is acceptable.
- **App identity.** A portal identifies the caller by app ID. A non-sandboxed Electron app may have none, and some backends then ask every time or refuse. Unverified.
- **wlroots and COSMIC.** The research notes list the portal route for them too. Whether the wlroots portal backend offers RemoteDesktop was not checked here. If it does not, what is left is the virtual keyboard and virtual pointer protocols, which have no consent step. By the plan's own rule (no route that skips consent) those are out unless the owner decides otherwise.
- **XWayland.** `xdotool` would reach only X11 windows run through XWayland, and would miss native Wayland windows without saying so. Not recommended.

### 12.3 Clicks

- **Best path:** AT-SPI actions on the named element. They go over D-Bus, need no pointer, and work under Wayland for GTK and Qt apps. This is the same element-based click as on the other platforms.
- **Pointer injection** through RemoteDesktop needs a ScreenCast stream to define absolute positions. That means screen-sharing consent and an indicator. Not proposed.

### 12.4 Recommendation

Do nothing for Wayland input until three things exist: the X11 versions of these steps are used and tested, an AT-SPI adapter exists for element lookup, and one compositor (GNOME 46 or later, or KDE 6) has been tested end to end with the RemoteDesktop portal. Start with GNOME and KDE, which share the portal route. Treat wlroots as a separate decision.

## 13. Decisions the owner must make

| # | Decision | Options | Recommendation |
| --- | --- | --- | --- |
| I1 | Build typing, clicking and sending in the next release at all? | Yes. No: keep them as level 2 drafts only. | Yes, level 3 only, after I2 to I9. |
| I2 | Effect class for typing and clicking | Always `external_effect`. By app class. | Always `external_effect`. Revisit with supervised-run data. |
| I3 | May typing and clicking target browsers? | Yes. No: use the DOM tier. | No. |
| I4 | Which apps may `send`? | Mail and chat only. Any app. | Mail and chat only. Each send approved every run, with no "do not ask again". |
| I5 | Typing on X11, where password fields cannot be detected | Allow, with the browser and exclusion rules. Block until AT-SPI exists. | Block until AT-SPI exists, or allow only for apps the owner lists. |
| I6 | Where text may come from | Literal text and approved options only. Also model output. | Literal and approved options only. Model output is ruled out by the Rule of Two. |
| I7 | Length limits | 200 characters per step and 500 per run. Other values. | 200 and 500. |
| I8 | How a click finds its target | Accessibility role and name only. Also coordinates. | Role and name only. |
| I9 | New permissions | macOS Accessibility, in addition to Automation. Windows: elevated windows unsupported. | Accept both, and say so in the permission text and the docs. |
| I10 | Where sends are recorded | A second table on the ledger page. A new ledger `purpose`. Run history only. | A second table on the ledger page. |
| I11 | Read-back of typed text | None. Compare a hash of the field value in memory, never stored. | None for now. Reading app content conflicts with plan §5.3 and needs its own review. |
| I12 | Who writes these steps | An authoring view the owner types into. Import from a file. | An authoring view only. Mining cannot produce them. |
| I13 | Wayland input through the RemoteDesktop portal | Pursue it. Wait. | Wait until the conditions in section 12.4 are met. |
| I14 | Company mode | Input steps on by default. Off by default and set by policy. | Off by default. Works councils and employers will ask who can make a machine type. |

## 14. What was and was not verified

Verified for this document:

- The code facts in section 2, by reading the files named at the top.
- `xdotool type --file -` takes text from stdin and typed a text with `$(id)`, quotes and backticks literally into an xterm under Xvfb and Openbox (xdotool 3.20160805.1).
- `/proc/self/cmdline` is mode 0444 and `/proc/self/environ` is mode 0400 on this machine.

Not verified:

- Everything about macOS and Windows adapters, permissions, Secure Event Input, UIPI and `SendInput` behaviour.
- Everything in section 12. There is no Wayland compositor in the build container.
- That a typing, click or send adapter works in any real app. None exists.
