#!/bin/bash
# Starts an AT-SPI bus and a window manager, then runs the benchmark driver, which starts a fresh GTK test window for each
# trial. Run it on a machine with nothing else busy, as:
#   AGENT_DESKTOP_BIN=/path/to/agent-desktop xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/run.sh
# Settings for the driver (all optional): OUT, TRIALS, CALLS, CLI_CALLS, STAGES, PYTHON, APP_NAME. See bench.mjs.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
: "${AGENT_DESKTOP_BIN:?Set AGENT_DESKTOP_BIN to the path of the agent-desktop binary}"
export GTK_A11Y=atspi GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
BUS=$!
openbox >/dev/null 2>&1 &
WM=$!
sleep 3
node "$HERE/bench.mjs" "$@"
RESULT=$?
kill "$BUS" "$WM" 2>/dev/null
exit "$RESULT"
