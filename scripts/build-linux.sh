#!/bin/bash
#
# ingesto — Professional Camera Media Ingest
# Copyright (C) 2026 Just Edit (Arnaud Augst)
#
# This program is free software: you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation, either version 3 of the License, or
# (at your option) any later version.
#
# This program is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program. If not, see <https://www.gnu.org/licenses/>.
#

# ╔══════════════════════════════════════════════════════════╗
# ║  Build the Linux packages. Run this ON a Linux machine.   ║
# ║  Cross-building Linux packages from macOS is not          ║
# ║  supported: the .deb produced there is invalid, so this   ║
# ║  is the only supported path.                              ║
# ║  Output: dist/ingesto-<version>.AppImage                  ║
# ║          dist/ingesto_<version>_amd64.deb                 ║
# ╚══════════════════════════════════════════════════════════╝

set -e
SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

# ── Prerequisites ─────────────────────────────────────────────────────────
if ! command -v node >/dev/null 2>&1; then
  echo "✗ Node.js is missing. Install it first:"
  echo "    sudo apt install nodejs npm"
  echo "  (Node 18 or newer is required — check with: node -v)"
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "✗ Node.js $(node -v) is too old — 18 or newer is required."
  echo "  On Pop!_OS / Ubuntu the repo version is often outdated; install a"
  echo "  current one from https://deb.nodesource.com or via nvm."
  exit 1
fi
for TOOL in dpkg-deb fakeroot; do
  command -v "$TOOL" >/dev/null 2>&1 || MISSING="$MISSING $TOOL"
done
if [ -n "$MISSING" ]; then
  echo "✗ Missing build tools:$MISSING"
  echo "    sudo apt install dpkg fakeroot"
  exit 1
fi

# ── Icons ─────────────────────────────────────────────────────────────────
# electron-builder wants a directory of <size>x<size>.png files for Linux.
# If the Mac build already produced it, reuse it as is.
ICONDIR="build-resources/icons"
if [ ! -d "$ICONDIR" ]; then
  echo "→ Generating $ICONDIR"
  if command -v magick >/dev/null 2>&1; then CONV="magick"
  elif command -v convert >/dev/null 2>&1; then CONV="convert"
  else
    echo "✗ ImageMagick is missing (needed to convert the app icon):"
    echo "    sudo apt install imagemagick"
    exit 1
  fi
  # The .ico holds several sizes; take the largest frame as the source.
  rm -f /tmp/ingesto_icon_*.png
  $CONV build-resources/icon.ico /tmp/ingesto_icon_%d.png 2>/dev/null || true
  SRC="$(ls -S /tmp/ingesto_icon_*.png 2>/dev/null | head -1)"
  if [ -z "$SRC" ]; then
    # Fallback: some ImageMagick builds read .icns directly
    $CONV build-resources/icon.icns /tmp/ingesto_icon_%d.png 2>/dev/null || true
    SRC="$(ls -S /tmp/ingesto_icon_*.png 2>/dev/null | head -1)"
  fi
  if [ -z "$SRC" ]; then
    echo "✗ Could not extract the icon from build-resources/."
    echo "  Drop a square PNG (512x512 or larger) at build-resources/icon-source.png"
    echo "  and re-run this script."
    [ -f build-resources/icon-source.png ] && SRC="build-resources/icon-source.png" || exit 1
  fi
  mkdir -p "$ICONDIR"
  for S in 16 32 48 64 128 256 512; do
    $CONV "$SRC" -resize ${S}x${S} "$ICONDIR/${S}x${S}.png"
  done
  rm -f /tmp/ingesto_icon_*.png
  echo "  $(ls -1 "$ICONDIR" | wc -l) icon sizes generated"
fi

# ── Build ─────────────────────────────────────────────────────────────────
echo "→ Installing dependencies"
npm install

echo "→ Building AppImage + deb"
npx electron-builder --linux AppImage deb

echo
echo "Done. Packages are in dist/:"
ls -1 dist/*.AppImage dist/*.deb 2>/dev/null || true
echo
echo "Install the deb:   sudo apt install ./dist/ingesto_*_amd64.deb"
echo "Run the AppImage:  chmod +x dist/ingesto-*.AppImage && ./dist/ingesto-*.AppImage"
echo
echo "Note: AppImages need FUSE 2 to start quickly. If launching feels slow:"
echo "    sudo apt install libfuse2t64"
