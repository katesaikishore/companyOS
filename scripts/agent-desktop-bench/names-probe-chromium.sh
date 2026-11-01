#!/bin/bash
# One-off check of the app-name mismatch with a real browser. companyOS records a Linux app by its X11 window class. The
# program (agent-desktop) knows an app by its process name. This starts Chromium with accessibility on, then prints the
# window class from xprop, the program's app list, and whether `focus-window --app <name>` accepts several spellings. It
# does not call the built-in adapter. It starts its own AT-SPI bus and window manager. Run it as:
#   AGENT_DESKTOP_BIN=/path/to/agent-desktop CHROMIUM=/path/to/chrome \
#     xvfb-run -a dbus-run-session -- scripts/agent-desktop-bench/names-probe-chromium.sh
set -u
: "${AGENT_DESKTOP_BIN:?Set AGENT_DESKTOP_BIN to the path of the agent-desktop binary}"
CHROMIUM="${CHROMIUM:-/opt/pw-browsers/chromium}"
PROFILE="$(mktemp -d)"
export GTK_A11Y=atspi GNOME_ACCESSIBILITY=1 NO_AT_BRIDGE=0
/usr/libexec/at-spi-bus-launcher --launch-immediately >/dev/null 2>&1 &
BUS=$!
openbox >/dev/null 2>&1 &
WM=$!
sleep 3
"$CHROMIUM" --no-sandbox --force-renderer-accessibility --user-data-dir="$PROFILE" --no-first-run --disable-gpu about:blank >/dev/null 2>&1 &
BROWSER=$!
sleep 8
echo "--- browser: $("$CHROMIUM" --version 2>/dev/null | head -1) ($(readlink -f "$CHROMIUM"))"
echo "--- X11 windows (instance, class)"
for id in $(xdotool search --onlyvisible --name 'about:blank' 2>/dev/null | head -3); do
  echo "id=$id $(xprop -id "$id" WM_CLASS 2>/dev/null | cut -c1-100)"
done
echo "--- program: list-apps"
"$AGENT_DESKTOP_BIN" list-apps 2>&1 | head -c 400; echo
for name in chromium Chromium chrome Chrome Chromium-browser; do
  printf 'focus-window --app %s -> ' "$name"
  "$AGENT_DESKTOP_BIN" focus-window --app "$name" 2>&1 | python3 -c "import sys,json; d=json.load(sys.stdin); print('ok' if d.get('ok') else d.get('error',{}).get('code'))"
done
kill "$BROWSER" "$BUS" "$WM" 2>/dev/null
wait "$BROWSER" 2>/dev/null
sleep 1
rm -rf "$PROFILE" 2>/dev/null
