# Title: `press` crashes a GTK 3 application (SIGSEGV in libgtk-3, gtk_main_do_event) on Linux/X11

## Summary

On Ubuntu 24.04 (X11, openbox), repeated `agent-desktop press <chord> --app <name>` calls make a GTK 3 window die with a
segmentation fault inside `gtk_main`. Focus, `status`, `snapshot` and `list-apps` do not reproduce it. Key injection with
`xdotool key` does not reproduce it either.

## Environment

- agent-desktop 1.0.2 (npm `agent-desktop@1.0.2`)
- Ubuntu 24.04, x86_64; at-spi2-core 2.52.0; GTK 3.24.41; Python 3.12 with PyGObject 3.48.2
- xdotool 3.20160805.1; Xvfb; openbox as window manager

## Reproduction

1. Start a GTK 3 window whose title is `ADTestApp` (any window with an accessible Entry and Button works).
2. Run `agent-desktop press ctrl+a --app python3.12` 60 times in a row, against a fresh window.
3. The window dies in most trials, usually within 10 to 30 presses. `--headed` dies too.

Stress results, 60 calls per trial, fresh window each trial:

| Loop | Trial 1 | Trial 2 | Trial 3 |
|---|---|---|---|
| status | alive | alive | alive |
| snapshot --app -i | alive | alive | alive |
| focus-window --app | alive | alive | alive |
| press ctrl+a (headless) | died | died | died |
| press ctrl+a --headed | died | died | died |
| focus-window, then press | died | died | alive |

Controls that did not crash, 30 presses per mode: `xdotool key --clearmodifiers ctrl+a` with and without a focus change.

## Backtrace

`gdb` backtrace at the crash: SIGSEGV at `gtk_main_do_event+3488` in libgtk-3.so.0, under `gtk_main`, `g_main_loop_run`,
libgdk and the Python interpreter. No libatspi, libatk-bridge, libxtst or libc frame is on the stack. The faulting
instruction is a pointer load inside GTK's event dispatch.

## Notes on what was ruled out

- A Python client that replays the same AT-SPI calls as the press (two `window:activate` registrations, the same tree
  reads, then the key) did not crash in 3 trials of 60 presses. This is unexplained: the crash still happens with the
  stress script on the same machine.
- Killing an earlier test window before starting the measured one raised the crash rate (3 of 3 trials, against 1 of 3
  without). The sample is small.

## Ask

Is there a known issue with the press path against GTK 3 accessibility, or a recommended invocation that avoids it? We
work around it by sending keys with xdotool after focus-window, which has not crashed in our tests.
