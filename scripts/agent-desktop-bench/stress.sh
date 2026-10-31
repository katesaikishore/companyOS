#!/bin/bash
# For each call type, runs 60 calls against a fresh GTK test window and reports whether the window survived.
# Run as: AGENT_DESKTOP_BIN=... xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/stress.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
PY="${PYTHON:-/usr/bin/python3.12}"
AD="$AGENT_DESKTOP_BIN"
export GTK_A11Y=atspi GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
openbox >/dev/null 2>&1 &
sleep 3
stage() {
  name=$1; shift
  "$PY" -X faulthandler "$HERE/testapp.py" >"$(mktemp)" 2>&1 & APP=$!
  sleep 4
  for i in $(seq 1 60); do "$@" >/dev/null 2>&1; done
  sleep 1
  if kill -0 $APP 2>/dev/null; then r=alive; else r=DIED; fi
  echo "$name: $r"
  kill $APP 2>/dev/null; wait $APP 2>/dev/null
  sleep 1
}
for trial in 1 2 3; do
  echo "-- trial $trial"
  stage status "$AD" status
  stage snapshot "$AD" snapshot --app python3.12 -i
  stage focus "$AD" focus-window --app python3.12
  stage press_headless "$AD" press ctrl+a --app python3.12
  stage press_headed "$AD" press ctrl+a --app python3.12 --headed
  stage focus_then_press bash -c "$AD focus-window --app python3.12 >/dev/null 2>&1; $AD press ctrl+a --app python3.12"
done
