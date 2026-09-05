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
# Node 20.19+ is a hard requirement of the build tooling (electron-builder 26):
# older Nodes crash mid-build with a cryptic "ERR_REQUIRE_ESM ... @noble/hashes"
# error. Ubuntu/Pop!_OS's apt package is Node 18 — too old. We recommend 22 LTS.
node_ok() {
  command -v node >/dev/null 2>&1 && \
  node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'
}
node_too_old() {
  echo "✗ Node.js ${1:-is missing} — this build needs Node 20.19 or newer (22 LTS recommended)."
  echo "  The version from 'apt install nodejs' is too old. Install a current one:"
  echo ""
  echo "  Option A — nvm (no sudo, recommended). Paste these three lines:"
  echo "    curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash"
  echo "    \\. \"\$HOME/.nvm/nvm.sh\""
  echo "    nvm install 22"
  echo ""
  echo "  Option B — NodeSource (system-wide):"
  echo "    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -"
  echo "    sudo apt install -y nodejs"
  echo ""
  echo "  Then run this script again."
  exit 1
}
# If the system Node is too old but nvm is installed (a freshly-installed nvm
# isn't loaded until the terminal restarts), load it ourselves and use its
# default — this alone un-sticks the classic "installed nvm, same error" trap.
if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
  echo "→ System Node is too old — loading nvm…"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  \. "$NVM_DIR/nvm.sh" || true
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi
if ! command -v node >/dev/null 2>&1; then
  node_too_old "is not installed"
fi
node_ok || node_too_old "$(node -v) is too old"
echo "✓ Node.js $(node -v)"
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
# npm ci installs exactly what package-lock.json pins, so two builds with the
# same version number carry the same dependencies.
if [ -f package-lock.json ]; then npm ci; else
  echo "  ⚠ no package-lock.json — falling back to npm install (not reproducible)"
  npm install
fi

# Start from a clean slate for THIS platform, so a failed build cannot leave
# the previous version's packages behind and have them listed as this build's
# output. Only the Linux artefacts go — removing the whole dist/ also destroyed
# a Mac or Windows build sitting beside them.
rm -rf dist/*.AppImage dist/*.deb dist/linux-unpacked dist/linux-* dist/latest-linux.yml

echo "→ Building AppImage + deb"
npx electron-builder --linux AppImage deb

# koffi's native binary is what lets ingesto bypass the OS cache during
# verification. If packaging drops it, koffi reports "unavailable", verification
# silently reads from memory instead of the medium, and NOTHING says so at
# runtime. Refuse to claim success without it.
# Search only this platform's own output: since 2.5.0 a Mac or Windows build
# may sit beside it in dist/, and those packages bundle every koffi triplet —
# finding linux_x64 in one of them would pass a Linux build that lost it.
if [ ! -d dist/linux-unpacked ]; then
  echo "✗ Packaging problem: no packaged app found in dist/linux-unpacked"
  exit 1
fi
for TRIPLET in linux_x64 musl_x64; do
  if [ -z "$(find dist/linux-unpacked -path "*app.asar.unpacked/node_modules/koffi/build/koffi/$TRIPLET/koffi.node" 2>/dev/null | head -1)" ]; then
    echo "✗ Packaging problem: the cache-control binary (koffi, $TRIPLET) is missing"
    echo "  from the packaged app. Verification would silently stop reading the"
    echo "  medium and read from memory instead. Check asarUnpack/files for linux"
    echo "  in electron-builder.yml."
    exit 1
  fi
done
echo "✓ Cache-control binaries present (linux_x64, musl_x64)"

if [ -z "$(ls -1 dist/*.AppImage dist/*.deb 2>/dev/null)" ]; then
  echo "✗ No AppImage or .deb was produced — the build did not complete."
  exit 1
fi

echo
echo "Done. Packages are in dist/:"
ls -1 dist/*.AppImage dist/*.deb 2>/dev/null || true
echo
echo "Install the deb:   sudo apt install ./dist/ingesto_*_amd64.deb"
echo "Run the AppImage:  chmod +x dist/ingesto-*.AppImage && ./dist/ingesto-*.AppImage"
echo
echo "Note: AppImages need FUSE 2 to start quickly. If launching feels slow:"
echo "    sudo apt install libfuse2t64"
