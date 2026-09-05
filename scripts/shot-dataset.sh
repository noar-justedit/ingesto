#!/bin/bash
# Rebuilds the demo dataset used by scripts/shots.js. Linux/CI helper, not
# shipped behaviour — it only writes under /Volumes/ so the paths in the
# screenshots read like a real macOS edit suite.
set -e
P1L=/Volumes/CAM_A/DCIM
P1R=/Volumes/NAS_EDIT/PROJET_TOSCANE/01_RUSHES
P2L=/Volumes/SSD_MONTAGE/EXPORTS
P2R=/Volumes/NAS_EDIT/PROJET_TOSCANE/05_EXPORTS

rm -rf /Volumes/CAM_A /Volumes/SSD_MONTAGE
rm -rf "$P1R" "$P2R"
mkdir -p "$P1L/AUDIO" "$P1R" "$P2L" "$P2R" "$P1L/.Spotlight-V100"

[ -f /tmp/chunk ] || dd if=/dev/urandom of=/tmp/chunk bs=1M count=24 status=none
mk(){ : > "$1"; for i in $(seq 1 $2); do cat /tmp/chunk >> "$1"; done; }

mk "$P1L/A001_C001_260808AB.mov" 8
mk "$P1L/A001_C002_260808AB.mov" 10
mk "$P1L/A001_C003_260808AB.mov" 4
mk "$P1L/AUDIO/ZOOM0007_Tr1.wav" 2
printf '\0\0\0\0' > "$P1L/.DS_Store"
printf 'x' > "$P1L/.Spotlight-V100/store.db"

mk "$P2L/MASTER_v3_ProRes.mov" 7
mk "$P2L/MASTER_v3_h264.mp4" 1
mk "$P2R/MASTER_v2_h264.mp4" 1

# one already-synced file so the "identical" chip is not zero
cp "$P1L/A001_C003_260808AB.mov" "$P1R/"
touch -r "$P1L/A001_C003_260808AB.mov" "$P1R/A001_C003_260808AB.mov"

rm -rf /home/claude/shome/Library "$P1R/.syncto"* "$P2R/.syncto"* 2>/dev/null || true

# The profile the camera sees: a saved job with two pairs, and a recent list
# that is not empty. Written before the app starts, with the app's own config
# module — no poking at a running window.
HOME=/home/claude/shome node "$(dirname "$0")/shot-seed.js" \
  /home/claude/shome/.config/syncto "/home/claude/shome/syncto jobs"

echo "dataset ready"
