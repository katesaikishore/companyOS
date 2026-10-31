#!/bin/bash
# Starts AT-SPI, a window manager and a GTK test window, then runs the executor benchmark.
# Run as: AGENT_DESKTOP_BIN=... xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/run.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
export GTK_A11Y=atspi GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0
export KEY_LOG="${KEY_LOG:-$(mktemp)}"
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
openbox >/dev/null 2>&1 &
sleep 3
touch "$KEY_LOG"
PY="${PYTHON:-/usr/bin/python3.12}"
"$PY" "$HERE/testapp.py" >/dev/null 2>&1 &
APP=$!
sleep 4
node "$HERE/executor-real.mjs"
RESULT=$?
if kill -0 "$APP" 2>/dev/null; then echo "test app still running"; else echo "WARNING: the test app died during the run; discard these results"; RESULT=2; fi
kill "$APP" 2>/dev/null
exit "$RESULT"
