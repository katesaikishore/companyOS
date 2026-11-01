# agent-desktop `press` crash: upstream status

Recorded 2026-11-01. Follows `docs/research/agent-desktop-performance.md`, which was re-recorded on 2026-11-01 with `scripts/agent-desktop-bench/bench.mjs`.

**Status: tracked upstream. Our draft issue was not posted.** The same crash is reported in
[vercel-labs/agent-desktop#384](https://github.com/vercel-labs/agent-desktop/pull/384), an open pull request with a
proposed fix. Posting our draft as a new issue would duplicate it. Our evidence is kept below because it matches the
cause given there.

We opened [vercel-labs/agent-desktop#408](https://github.com/vercel-labs/agent-desktop/pull/408) as an alternative to
#384. #384 waits 200 ms after every key. #408 waits once at process exit, until the last key is 200 ms old, so a batch
of presses pays the wait once. It has not been run against a live X11 session.

## The crash

On Linux/X11, repeated `agent-desktop press <chord> --app <name>` calls made our GTK 3 test window die with a
segmentation fault inside `gtk_main`, in 26 of 30 trials of the re-recorded final pair and in 36 of 40 earlier ones.
Focus, `status`, `snapshot` and `list-apps` do not reproduce it. Key injection with `xdotool key` does not reproduce it
either.

## Cause given upstream

From #384 and its follow-up comment:

- Each `agent-desktop` call is a short-lived process. It registers with the AT-SPI registry as a client, sends the key
  and exits.
- When the last AT-SPI client leaves the bus, at-spi2's ATK bridge in the app removes its key listener
  (`spi_atk_deregister_event_listeners`, then `atk_remove_key_event_listener`).
- The app can still be inside that listener at that moment. The listener waits for the registry in a nested main loop
  (`send_and_allow_reentry`), so the removal frees the listener while it is on the stack. GTK then crashes on return.
- The author read this path in the at-spi2-core source and did not capture the crash inside that exact call. They tied
  it to the process exit by measurement: waiting 200 ms before exit gave 0 of 24 crashes against 5 of 24, and
  `NO_AT_BRIDGE=1` gave 0 of 8 against 3 of 8. A second AT-SPI client that stays on the bus also stopped it.

## How our evidence fits

- **Backtrace.** Our `gdb` backtrace shows SIGSEGV at `gtk_main_do_event+3488` in libgtk-3, with no libatspi or
  libatk-bridge frame on the stack. That fits GTK touching the removed listener after the bridge code has returned,
  rather than a crash inside the bridge.
- **Press only.** On the proposed cause, only `press` can leave the bus while the app is inside the key listener,
  because only `press` sends a key. Focus, snapshot and status send no key.
- **xdotool control.** `xdotool key` is not an AT-SPI client, so nothing leaves the bus after the key.
- **Python replay.** Our replay of the same AT-SPI calls did not crash in 3 trials of 60 presses, and we could not
  explain it. The replay script is not in the repo, so we cannot check whether it kept one bus connection across
  presses. If it did, the cause above explains why it never crashed.
- **Earlier window killed.** Killing an earlier test window raised the crash rate (3 of 3 against 1 of 3). The cause
  above does not explain this, and the sample was small.

Stress results from the first record (2026-10-31), 60 calls per trial, fresh window each trial (Ubuntu 24.04, Xvfb, openbox,
at-spi2-core 2.52.0, GTK 3.24.41, agent-desktop 1.0.2). They came from a stress script that has since been replaced by
`scripts/agent-desktop-bench/bench.mjs`. The re-recorded results are in the performance record: the program's own `press` killed the
test window in 26 of 30 trials of the final pair and in 36 of 40 earlier ones. The first record's table follows:

| Loop | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| status | alive | alive | alive |
| snapshot --app -i | alive | alive | alive |
| focus-window --app | alive | alive | alive |
| press ctrl+a (headless) | died | died | died |
| press ctrl+a --headed | died | died | died |
| focus-window, then press | died | died | alive |

## What this changes for companyOS

Nothing yet. Linux presses still go through `xdotool` after the focus check (`linux-press-xdotool`, merged in PR #4), and
agent-desktop stays optional and off by default. Revisit when a fix is released upstream and verified against the
benchmark (`bench.mjs`, the press stages).
