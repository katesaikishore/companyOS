# Research track: os-capture

# companyOS: desktop shell and OS-level activity capture (research as of 2026-10-30)

## 1. App shell and process model

**Versions:** Tauri core is at 2.11.5 (2026-07-01). Electron's latest stable is 45.1.0 (2026-10-27; Chromium 156, Node 24.22). Electron supports only the latest 3 majors, so you have to upgrade roughly every 8 weeks.

**Tauri 2 vs Electron for an always-on agent**
- Published benchmarks disagree a lot. Idle RAM for Tauri is 42–109 MB vs 128–168 MB for Electron. Bundle size is about 9–57 MB for Tauri vs 244–323 MB for Electron. Treat any single multiplier as marketing.
- The deciding factor is not the UI. The capture/twin engine must be native code with direct OS bindings, and Rust is the natural fit. Tauri gives us a Rust host process for free.
- Tauri drawbacks:
  - The webview differs per OS: WKWebView, WebView2 and WebKitGTK. WebKitGTK lags on LTS distros.
  - Tauri has no built-in macOS `.pkg` output (only `.app`/`.dmg`).
  - Its MSI uses WiX, and the docs disagree on whether that is WiX v3 or v6.
- **Recommendation:** use a Rust core plus Tauri 2 for the UI. Do not use Electron, because shipping a Node runtime in an always-on agent is pure overhead.

**Process split (recommended)**
- `twin-agent` is a headless Rust daemon (tokio) that runs **in the user's GUI session**. It does capture, local storage, redaction and the automation runtime.
  - macOS: a per-user LaunchAgent or login item registered via `SMAppService` (macOS 13+). Not a LaunchDaemon.
  - Windows: a per-user logon task or Run key. **Not a Windows Service**, because Session 0 cannot see desktop windows or hook input.
  - Linux: a `systemd --user` unit bound to `graphical-session.target`.
- `companyOS` UI is a Tauri tray app whose webviews are created on demand and destroyed when closed.
- IPC runs over a Unix socket or named pipe (e.g. the `interprocess` crate), authenticated with a per-install token.
- **macOS TCC gotcha:** permissions are attributed to the "responsible process". Apple DTS says a helper embedded inside the app bundle is attributed to the app. Standalone or versioned binaries get mis-attributed, or lose their grant on every update.
  - So: ship the agent as a bundled helper (`Contents/Library/LoginItems/…app`) with a stable Developer ID designated requirement.
  - Verify the attribution in a spike before building on it.

**Resource budget (set as release gates)**
- Agent: under 1% average CPU, under 100–150 MB RSS, no continuous video, and disk growth in the MB/day range.
- For contrast, screenpipe (Rust + Tauri, always-on screenshots + OCR) self-reports 5–15% CPU and 5–20 GB/month. That is unacceptable for an employee fleet and is the cautionary benchmark.
- Techniques:
  - Capture on events, not on a frame rate.
  - Prefer accessibility text over OCR: an AX walk takes ~10–50 ms on macOS vs ~200–500 ms for UIA on Windows.
  - Dedupe screenshots with a perceptual hash.
  - Do heavy work only on AC power or when idle.
  - Use OS throttling: macOS `QOS_CLASS_UTILITY`/`BACKGROUND`; Windows EcoQoS via `SetProcessInformation(ProcessPowerThrottling)`.

## 2. Per-OS capture APIs

### macOS

| Signal | API | Permission (TCC) |
|---|---|---|
| Active app | `NSWorkspace.didActivateApplicationNotification` | none |
| Window titles/geometry | `CGWindowListCopyWindowInfo` | titles need Screen Recording |
| Focused element, text, URL, roles | `AXUIElement` / `AXObserver` (focus/title/value-changed notifications) | **Accessibility** (`AXIsProcessTrustedWithOptions`) |
| Input events (counts/chords) | `CGEventTap` **listenOnly** | **Input Monitoring** (`CGPreflightListenEventAccess`/`CGRequestListenEventAccess`). A `defaultTap` (one that can modify events) needs Accessibility instead. |
| Pixels | ScreenCaptureKit (`SCShareableContent`, `SCScreenshotManager`, `SCStream`) | **Screen & System Audio Recording** |

- **Screen-recording friction is the main obstacle:**
  - Sequoia 15.0 added recurring re-approval prompts, monthly after the beta; 15.1 reduced them for regularly used apps. Developers have no way around them.
  - ScreenCaptureKit also shows its own, separate periodic reminder.
  - On macOS 26/Tahoe, `CGRequestScreenCaptureAccess` sometimes shows no prompt. The workaround is to call `SCShareableContent` as well.
  - The `com.apple.developer.persistent-content-capture` entitlement is for VNC/remote-desktop apps and needs Apple approval. **Do not plan on it.**
- **Chromium/Electron apps hide their AX tree** unless an assistive technology is detected. Set `AXManualAccessibility` (Electron) or `AXEnhancedUserInterface` (Chrome) on the app element. This costs some performance.
- **Redaction at source:** skip `AXSecureTextField`, honour `IsSecureEventInputEnabled()`, and remember that windows with `sharingType = .none` render black.
- **Sandbox:** a listen-only event tap works in the App Store sandbox (10.15+). Accessibility-based introspection does not, so distribute with **Developer ID + hardened runtime + notarization**, not through the Mac App Store.
- **macOS 27 (shipped 2026-09-15) affects enterprise rollout:**
  - The PPPC `Accessibility` grant was deprecated in 26.2. On 27 the user is notified and can switch it off.
  - The new declarative `Privacy` key (`com.apple.configuration.app.settings`, PermissionDefaults) produces one consolidated prompt with Allow as the default button. It is **never silent**.
  - `ScreenCapture` and `ListenEvent` stay in PPPC and can only be denied. `AllowStandardUserToSetSystemService` lets non-admins approve them.
  - Apps can no longer read `TCC.db`.
  - New "binary control" (`AllowedBinaries` by Team ID) means customers must allow-list our Team ID.

### Windows

- **Foreground and title changes:**
  - Use `SetWinEventHook` with `EVENT_SYSTEM_FOREGROUND`, `EVENT_OBJECT_NAMECHANGE` and `EVENT_OBJECT_FOCUS`, flag `WINEVENT_OUTOFCONTEXT`.
  - Needs no admin rights and no DLL injection.
  - Map the window to a process with `GetWindowThreadProcessId` + `QueryFullProcessImageNameW`.
- **UI Automation** gives the focused element, `ControlType`, `Name`, `ValuePattern`, and `IsPassword` (use it for redaction). It can also read the browser address bar.
  - Crates: `uiautomation` 0.25.1 (wrapper; enable the `event` feature) or raw `windows` 0.62.
- **Input hooks:**
  - `WH_KEYBOARD_LL` / `WH_MOUSE_LL` need a message loop on a dedicated thread.
  - `LowLevelHooksTimeout` is capped at 1000 ms (Win10 1709+). On Windows 7+ a hook that times out is **silently removed**, so add a watchdog that re-installs it.
  - Microsoft recommends Raw Input (`RIDEV_INPUTSINK`) for monitoring.
  - UIPI hides input sent to elevated windows unless the agent is elevated or has `uiAccess` (signed and installed under Program Files). This UIPI detail comes from general knowledge, not a primary source.
  - Unsigned low-level keyboard hooks are a classic AV keylogger heuristic, so code signing is mandatory.
- **Windows.Graphics.Capture:**
  - Win32 apps get programmatic capture with no picker via `IGraphicsCaptureItemInterop::CreateForWindow/CreateForMonitor`.
  - A yellow border is drawn unless `GraphicsCaptureAccess.RequestAccessAsync(Borderless)` gets user consent **and** the `graphicsCaptureWithoutBorder` manifest capability is declared. That requires package identity (MSIX or a sparse package).
  - Windows set to `WDA_EXCLUDEFROMCAPTURE` render black.
- **ETW** kernel process/file providers need admin rights. Use them only in enterprise mode; otherwise poll the process list.
- **Recall era:**
  - Recall is Copilot+ only and opt-in, with an encrypted store and **no general third-party read API**. Snapshot export is EEA-only and user-initiated.
  - Apps can only contribute `UserActivity` deep links and `ContentInfo` sensitivity labels; DLP vendors get a Recall DLP Provider API.
  - Don't depend on Recall. Mirror its controls, such as honouring capture-exclusion and DLP labels.
  - The agentic Windows stack is a later-phase integration target for "make it work itself": MCP on Windows / On-Device Registry (preview), Agent Workspace (experimental Copilot Actions), and `Windows.UI.Shell.Tasks` for taskbar agents.

### Linux

- **X11** is fully introspectable: EWMH `_NET_ACTIVE_WINDOW`/`_NET_WM_NAME` via `x11rb`, XInput2 for input, XScreenSaver for idle.
- **X11 is disappearing.** GNOME 49 dropped the GNOME-on-X11 session (full removal is planned for GNOME 50), and Fedora 43 and Ubuntu 25.10 ship Wayland-only GNOME.
- **Wayland has no global window or input introspection, by design.** Each compositor needs its own path:
  - wlroots, Hyprland and COSMIC: `wlr-foreign-toplevel-management` (title, app_id, activated state) plus `ext-idle-notify-v1`.
  - KDE: a bundled KWin script that reports to us over D-Bus (the awatcher pattern). Idle comes from the KDE idle protocol or `ext-idle-notify`.
  - GNOME: needs a shell extension; either use "Focused Window D-Bus" (extensions.gnome.org #5592) or ship our own. Idle comes from `org.gnome.Mutter.IdleMonitor`.
  - `ext-foreign-toplevel-list` support in Mutter and KWin is unconfirmed.
- **No passive keyboard or mouse monitoring on Wayland.**
  - The InputCapture portal (libei, x-d-p 1.17+) is for Synergy-style pointer-barrier capture, not monitoring.
  - Reading `/dev/input` through evdev needs the `input` group, which makes us a root-equivalent keylogger. **Reject this.**
- **Portals** (Rust: `ashpd` 0.13; it notes an x-d-p-gnome 46.0 bug with re-enabling sessions):
  - ScreenCast: the user picks the source once; use `persist_mode=2` plus a `restore_token`. Tokens are single-use, so store the rotated one each time.
  - GlobalShortcuts: KDE 6+, GNOME 48+, Hyprland. `BindShortcuts` can be called only once per session.
  - RemoteDesktop (input injection via libei) is for executing automations later, behind a consent dialog.
- **AT-SPI2** works under Wayland for GTK and Qt apps (focus, name and role events). Crate: `atspi` 0.29 on `zbus`.
  - The accessibility bus must be enabled.
  - Chromium/Electron need `--force-renderer-accessibility` or AT detection.
- **Do not ship the agent as Flatpak, Snap or AppImage**, because sandboxed builds cannot query Wayland activity (per awatcher). Use `.deb`/`.rpm`.

## 3. Browser activity (MV3 + native messaging)

- **Permissions:** `tabs` (URL and title), `webNavigation`, `history`, `idle`, `scripting` plus host permissions for content scripts.
  - `<all_urls>` triggers the strongest install warning and Chrome Web Store "Limited Use" disclosure requirements.
  - Incognito is opt-in per user.
  - The extension cannot see `chrome://` pages, the Web Store or other extensions.
- **Native messaging:**
  - Host-to-browser messages are limited to 1 MB; browser-to-host to 64 MiB.
  - Host manifests live at:
    - Windows: `HKCU|HKLM\SOFTWARE\Google\Chrome\NativeMessagingHosts\<name>` (Edge uses `…\Microsoft\Edge\…`).
    - macOS: `~/Library/Application Support/Google/Chrome/NativeMessagingHosts/` (`/Library/…` for system-wide installs).
    - Linux: `~/.config/google-chrome/NativeMessagingHosts/` (`/etc/opt/chrome/…` for system-wide installs).
  - `allowed_origins` cannot use wildcards.
  - Chrome documents native messaging as keeping the MV3 service worker alive beyond 5 minutes. Still persist state in `chrome.storage`.
- **Firefox** supports native messaging and still offers `webRequest` in MV3.
- **Safari** needs an app-extension wrapper (`SafariWebExtensionHandler`) and has no stdio host; it is unreliable at waking the background page. Defer Safari.
- **Enterprise:** `ExtensionInstallForcelist`, `NativeMessagingAllowlist`, and `NativeMessagingUserLevelHosts` (false blocks per-user hosts, so install the host system-wide).
- **Fallback without the extension:** read the URL through UIA (Windows) or AX (macOS) on the address bar. This gives coarser data.

## 4. Other signals and on-device OCR

- **Filesystem:** the `notify` crate (FSEvents / ReadDirectoryChangesW / inotify).
  - inotify is bounded by `fs.inotify.max_user_watches`.
  - None of these tell you *which process* changed a file. Getting that needs macOS Endpoint Security (entitlement and system extension), ETW (admin) or fanotify (`CAP_SYS_ADMIN`), so it is a later, enterprise-only feature.
  - "Recent documents" also comes from window titles, Spotlight `kMDItemLastUsedDate` and `recently-used.xbel`.
- **Clipboard:** macOS is adding a pasteboard privacy alert.
  - `NSPasteboard.accessBehavior` defaults to `.ask` for the general pasteboard.
  - Detecting the *types* on the pasteboard without reading them does not trigger the alert.
  - Whether the alert is on by default in macOS 26/27 is unverified.
  - **Capture clipboard types and events only, never contents.** This also fits the anonymity requirement.
- **Calendar and email:** prefer cloud APIs with metadata-only scopes.
  - Microsoft Graph: `Calendars.Read`, `Mail.ReadBasic` (no body).
  - Google: `gmail.metadata` is a restricted scope that needs a CASA security assessment.
  - macOS EventKit needs `requestFullAccessToEvents` (macOS 14+).
- **OCR (fallback only, for Citrix/RDP, canvas apps and images):**
  - macOS: Apple Vision `VNRecognizeTextRequest`; the Swift `RecognizeTextRequest` needs macOS 15+.
  - Windows: `Windows.Media.Ocr` runs on CPU on any Win10+ machine (language packs required). The new Windows AI `TextRecognizer` needs a Copilot+ PC with an NPU.
  - Linux: Tesseract 5, or PaddleOCR PP-OCR models through ONNX Runtime (`ort`); "faster-paddle" self-reports a ~6 MB tiny model.

## 5. Rust crates and their maturity

- **Production-grade:**
  - `windows` 0.62.x (Microsoft)
  - `objc2` family 0.3.x: `objc2-app-kit`, `objc2-application-services` (feature `AXUIElement`), `objc2-screen-capture-kit` 0.3.2, `objc2-vision`
  - `x11rb`, `wayland-client` + `wayland-protocols(-wlr)`, `zbus` 5, `ashpd` 0.13, `atspi` 0.29, `notify`, `rusqlite` (SQLCipher)
- **Use with care:**
  - `active-win-pos-rs` (0.9.x) is X11-only on Linux.
  - `xcap` (0.9.4) handles X11 and Wayland screenshots; recording is still WIP.
  - `scap` (CapSoftware; 0.0.8 to 0.1.0-beta, last push Aug 2025) is stale.
  - `rdev` upstream is unmaintained, and its forks are fragmented (rustdesk-org, `openloaf-rdev` 0.5.1, which fixes macOS tap re-enable). It is X11-only on Linux.
  - `uiautomation` 0.25.1 is maintained by a single developer.
- **Recommendation:** write thin, first-party per-OS adapters on top of `windows`, `objc2` and `wayland`/`zbus` rather than depending on the cross-platform convenience crates.

## 6. Packaging, signing, update and MDM

- **macOS:**
  - Developer ID Application/Installer certificates, hardened runtime, `notarytool` and stapling.
  - Build the `.pkg` with `productbuild` in CI for Jamf and Intune-for-Mac (Tauri can't produce one).
  - Ship profiles with it: a PPPC profile (ScreenCapture/ListenEvent → `AllowStandardUserToSetSystemService`), the macOS 27 declarative `Privacy` defaults for Accessibility, a managed login-item / background-task profile (`com.apple.servicemanagement`), and a Team ID allow-list for binary control.
- **Windows:**
  - Code signing:
    - **EV certificates no longer give instant SmartScreen reputation**, and neither does Azure Artifact Signing (formerly Trusted Signing). Reputation builds per file.
    - Artifact Signing costs $9.99/mo for 5k signatures. Its availability is GA for US/CA orgs, but onboarding for individuals and non-US customers is reportedly restricted.
    - Publicly trusted code-signing certificates are capped at **460 days since 2026-03-01** (CSC-31), and keys must be held on an HSM.
  - Installers: NSIS for consumers; MSI (WiX) or Win32 `.intunewin` for Intune/GPO.
  - Consider MSIX or a sparse package to get package identity (needed for borderless WGC and the Windows AI APIs).
  - Smart App Control can block unknown binaries.
- **Linux:** `.deb`/`.rpm` plus an apt/dnf repository. Ship the GNOME extension and the KWin script with the package.
- **Updates:**
  - `tauri-plugin-updater` uses its own signing key, separate from the OS code signature. Use it for personal mode.
  - In company mode, disable self-update and let the MDM push versions. Updates must keep the same bundle ID and designated requirement, or TCC grants reset.

## 7. Recommended stack

- **Language and shell:** a Rust workspace, plus a Tauri 2.11 tray UI with a Svelte or React frontend.
- **Agent:** a headless `twin-agent` with these internals:
  - capture adapters for macOS, Windows and Linux (X11 / wlroots / KWin / GNOME)
  - a redaction filter that runs before anything is persisted
  - SQLCipher storage with FTS5
  - an event bus
- **Browser:** an MV3 extension for Chrome/Edge/Firefox plus a Rust native-messaging stub that forwards to the agent.
- **Text-first capture:** AX/UIA/AT-SPI text is the primary source. Screenshots + OCR are opt-in and off by default, which also suits the anonymity requirement.
- **Keystrokes:** never log key contents. Record only counts, shortcut chords and dwell time.

## 8. Capability matrix (MVP = v1; L = later; X = not feasible or rejected)

| Capability | macOS | Windows | Linux X11 | Wayland wlroots/COSMIC | Wayland KDE | Wayland GNOME |
|---|---|---|---|---|---|---|
| Active app + window title | MVP | MVP | MVP | MVP | MVP (KWin script) | MVP (extension) |
| Idle/active time | MVP | MVP | MVP | MVP | MVP | MVP |
| Focused element / UI text (a11y) | MVP (Accessibility) | MVP (UIA) | L (AT-SPI) | L (AT-SPI) | L | L |
| Input counts / shortcut chords | MVP (Input Monitoring) | MVP (Raw Input / LL hook) | MVP (XInput2) | X | X | X |
| Browser URL/title (extension) | MVP | MVP | MVP | MVP | MVP | MVP |
| Screenshots + OCR | L (opt-in; recurring prompts) | L (yellow border without package identity) | L | L (portal, one-time pick) | L | L |
| File events (no process attribution) | MVP | MVP | MVP | MVP | MVP | MVP |
| File events with process attribution | L (Endpoint Security) | L (ETW, admin) | L (fanotify) | L | L | L |
| Clipboard (types only) | L | L | L | L | L | L |
| Calendar/email metadata (Graph/Google) | MVP | MVP | MVP | MVP | MVP | MVP |
| Execute automations (UI) | L (AX actions + PostEvent) | L (UIA patterns + SendInput) | L (XTest) | L (RemoteDesktop portal/libei) | L | L |
| Silent MDM pre-grant of permissions | X (consent always shown on 27) | n/a (no TCC equivalent) | n/a | n/a | n/a | n/a |

## Key decisions
- **Which desktop shell to use** → Use a Rust core plus a Tauri 2.11 UI. Do not use Electron. — _The capture engine has to be native Rust anyway. Tauri adds a lighter UI and a smaller bundle. Electron would add a Node/Chromium runtime and an 8-week upgrade treadmill (45.1.0 is current) to an always-on agent._
- **How to split the processes** → Run a headless twin-agent in the user's GUI session as a per-user LaunchAgent, logon task or systemd --user unit, never a Windows Service or LaunchDaemon. Run the Tauri UI on demand and connect it to the agent over local IPC. — _Windows Session 0 services can't see windows or input. Running the agent in the user session keeps CPU and RAM low when the UI is closed and isolates crashes._
- **How to package the macOS helper for TCC** → Ship the agent as a helper .app embedded in the main bundle and register it with SMAppService. Sign it with a stable Developer ID designated requirement. Validate the attribution in a spike. — _TCC grants follow the responsible process and the code signature. Standalone or versioned binaries are mis-attributed or lose their grants on every update._
- **Primary capture modality** → Make text-first capture (AX, UIA, AT-SPI, window titles, browser extension) the MVP source. Make screenshots and OCR opt-in and off by default. — _macOS screen recording brings recurring re-approval prompts and an extra ScreenCaptureKit reminder, and MDM can't pre-grant it. Windows adds a capture border without package identity. Text-first is also far cheaper (a 10–50 ms AX walk vs 100–500 ms OCR) and fits the anonymity requirement._
- **Keystroke policy** → Never record key contents. Record only counts, shortcut chords and dwell time. Skip secure fields (AXSecureTextField, UIA IsPassword, Secure Event Input). — _This is required for anonymity. It avoids keylogger AV heuristics and regulatory exposure, and passive keystroke content is impossible on Wayland anyway._
- **Linux scope at MVP** → Support X11, wlroots/COSMIC, KDE (via a bundled KWin script) and GNOME (via a bundled shell extension) for window, idle and browser signals. Defer AT-SPI, screenshots and input. Ship .deb/.rpm, not Flatpak or AppImage. — _Wayland has no global introspection, so each compositor needs its own path. Sandboxed builds cannot query Wayland activity. evdev input access needs root-equivalent group membership, so it is rejected._
- **Browser capture approach** → Build an MV3 extension for Chrome, Edge and Firefox with a native-messaging host installed system-wide. Defer Safari. Force-install it in company mode via ExtensionInstallForcelist and NativeMessagingAllowlist. — _It gives the richest signals (URL, title, navigation, DOM on demand) at low cost. A system-wide host survives NativeMessagingUserLevelHosts=false. Safari's native messaging is awkward and unreliable._
- **Enterprise distribution** → macOS: a notarized .pkg built with productbuild, plus PPPC, the macOS 27 declarative Privacy defaults, a managed login-item profile and a Team ID allow-list. Windows: a signed MSI or .intunewin, with optional MSIX or sparse identity. In company mode the MDM controls updates. — _Tauri can't produce a .pkg. macOS 27 makes Accessibility consent user-visible and introduces binary allow-listing. MDM-controlled updates keep the code identity stable and keep TCC grants intact._
- **Windows code signing** → Use Azure Artifact Signing if the organization qualifies; otherwise use an OV certificate on a cloud HSM. Budget for SmartScreen reputation warm-up and the 460-day certificate rotation. — _EV no longer gives instant SmartScreen reputation. Artifact Signing is cheap ($9.99/mo) but restricted by geography. CA/B CSC-31 caps certificate validity at 460 days from 2026-03-01._

## Risks
- macOS screen-recording friction: recurring re-approval prompts (monthly since Sequoia) plus a separate periodic ScreenCaptureKit reminder. Developers can't suppress either, and MDM can't pre-grant the permission. Any feature that depends on screenshots will feel intrusive and break when users dismiss the prompt.
- macOS 27 changed MDM consent. A PPPC Accessibility grant is no longer silent: the user is notified and can turn it off. Fleet-wide 'it just works' deployment on Mac is impossible, so onboarding UX has to win consent.
- TCC attribution and identity. Changing the bundle ID, the signing team, the helper path or the designated requirement in an update silently resets grants and stops capture.
- Windows low-level hooks are silently removed if a callback exceeds LowLevelHooksTimeout (max 1000 ms). Without a watchdog, input signals vanish unnoticed.
- AV and EDR heuristics. Global keyboard hooks, screen capture and UIA scraping look like spyware. Corporate EDR (Defender, CrowdStrike) may quarantine the agent unless it is signed and allow-listed, and Smart App Control may block unknown builds.
- Wayland fragmentation. GNOME needs a shell extension that breaks across GNOME major versions, and KDE relies on a KWin script. X11 fallbacks are disappearing (GNOME 49/50, Fedora 43, Ubuntu 25.10). The maintenance burden is per compositor.
- Chromium/Electron apps (Slack, Teams, VS Code, Chrome) don't expose an accessibility tree by default. Forcing AXManualAccessibility or AXEnhancedUserInterface costs performance and can cause side effects in those apps.
- Resource creep. Always-on screenshot+OCR designs (e.g. screenpipe: 5–15% CPU, GBs per month) will fail fleet acceptance and battery expectations if adopted.
- Browser-store policy. A Chrome Web Store extension that collects browsing activity with <all_urls> faces Limited Use disclosure rules and review risk. Enterprises may block unlisted extensions or native-messaging hosts.
- Code-signing supply. Artifact Signing onboarding is reportedly restricted (US/CA orgs with 3+ years of history), and 460-day certificate rotation adds operational overhead.
- Legal and perception risk. The OS vendors' own analogues (Recall) drew heavy security criticism, including a 2026 report of decrypted-data exposure. A third-party 'twin' agent will get the same scrutiny, so the redaction-at-source guarantees must be real and auditable.
- Rust crate maturity. rdev (fragmented forks), scap (stale since Aug 2025) and active-win-pos-rs (X11-only) are not dependable foundations, so the team will own several thin per-OS adapters.

## Unverified
- Exact current cadence of the macOS 26/27 screen-recording re-approval prompt: sources conflict between weekly and monthly, and I found no Apple release-note confirmation for Tahoe or 27.
- Whether PPPC can pre-grant ListenEvent (Input Monitoring) Allow outright. The Apple key text says AllowStandardUserToSetSystemService is valid only for ListenEvent and ScreenCapture; third-party tables say ListenEvent can only be denied.
- Exact macOS 27 status of the Accessibility PPPC key. One source says it was removed in 27.0; a later correction citing the shipped release notes says deprecated, with a user notification and an off switch. I used the later version.
- Whether the macOS pasteboard privacy alert (NSPasteboard accessBehavior .ask) is on by default in macOS 26 or 27, or still behind a developer default.
- That a helper registered via SMAppService (agent or login item) is TCC-attributed to the parent app in all cases. This rests on DTS forum statements, not formal docs; it needs a spike.
- UIPI and uiAccess behaviour for low-level hooks observing elevated windows. This is from general knowledge; no primary source was retrieved.
- Whether Windows AI TextRecognizer requires package identity in addition to a Copilot+ NPU, and the current Windows App SDK status of the Recall/Click to Do developer integration.
- Status of Microsoft Artifact Signing onboarding for individuals and non-US organizations: the March 2026 'paused' claim comes from an AI-generated Q&A answer.
- Support for ext-foreign-toplevel-list and ext-idle-notify-v1 in Mutter and KWin by version: sources conflict (Mutter 45 vs 48; KWin 5.27 vs 6.4).
- Whether tauri-plugin-updater supports .deb/.rpm self-update on Linux, or only AppImage.
- Which Tauri WiX version is current (v3 vs v6): the official docs translations conflict.
- Resource figures: the Tauri vs Electron RAM numbers and screenpipe's CPU/RAM/disk numbers come from benchmarks or self-reports that disagree with each other.
- Whether Chrome's MV3 service-worker keep-alive for native messaging applies to connectNative ports in all current Chrome versions. The FAQ says it does, but the native-messaging page only says the host process stays alive while the port is open.
- Latest versions of xcap (0.9.4), scap, active-win-pos-rs (0.9.x) and windows-rs (0.62.2 vs windows-implement 0.100.0 numbering) as of October 2026.
