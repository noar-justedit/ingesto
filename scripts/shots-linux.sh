#!/bin/bash
# Takes the repository's screenshots on Linux (CI or a container).
#
# Three things have to be in place before the camera rolls, and getting any of
# them wrong shows up IN the pictures:
#   - a display               → Xvfb
#   - a session bus + keyring → so safeStorage reports itself available and the
#                               connection window is not photographed saying
#                               "this machine has no usable credential store",
#                               which is true here and false on every Mac
#   - the demo dataset        → scripts/shot-dataset.sh, which also seeds the
#                               profile the screenshots are taken against
set -e
cd "$(dirname "$0")/.."

export HOME=${SHOT_HOME:-/home/claude/shome}
mkdir -p "$HOME"

bash scripts/shot-dataset.sh

# The keyring has to be unlocked INSIDE the session bus, and the browser has to
# run inside both — hence one nested command rather than three steps.
dbus-run-session -- xvfb-run -a -s "-screen 0 1600x1000x24" bash -c '
  set -e
  rm -rf "$HOME/.local/share/keyrings"
  mkdir -p "$HOME/.local/share/keyrings"
  eval "$(printf "\n" | gnome-keyring-daemon --unlock --components=secrets)"
  export GNOME_KEYRING_CONTROL
  node scripts/shots.js
'
echo "screenshots written to ${SHOT_OUT:-docs/screenshots}"
