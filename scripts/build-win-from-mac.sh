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

# ╔══════════════════════════════════════════════════════════════╗
# ║       ingesto — Build Windows (.exe) from macOS              ║
# ║       Génère un installeur NSIS 64-bit pour Windows          ║
# ╚══════════════════════════════════════════════════════════════╝

set -e
# See build-mac.sh: pipefail is deliberately NOT set (a `grep -v` that filters
# every line exits 1 on success). PIPESTATUS is used instead.

RED='[0;31m'
GREEN='[0;32m'
YELLOW='[1;33m'
BLUE='[0;34m'
CYAN='[0;36m'
BOLD='[1m'
NC='[0m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${CYAN}      ingesto — Build Windows installer from macOS      ${NC}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

cd "$PROJECT_DIR"

# ── Cache-control binary check ───────────────────────────────────────────────
# koffi's native binary is what lets ingesto bypass the OS cache during
# verification. If packaging drops it, koffi reports "unavailable", verification
# silently stops hitting the medium and reads from memory instead, and NOTHING
# says so at runtime. So the build refuses to claim success without it.
check_koffi() {
  triplet="$1"
  scope="$2"
  # Search ONLY this platform's own output. The Windows and Linux packages
  # bundle every koffi triplet, so looking across the whole dist/ could find
  # darwin_arm64 inside win-unpacked/ and pass a Mac build that had actually
  # dropped it — the exact silent failure this check exists to catch. Since
  # 2.5.0 the other platforms' builds are no longer wiped, so the scope matters.
  roots=$(ls -d dist/$scope 2>/dev/null || true)
  if [ -z "$roots" ]; then
    echo ""
    echo -e "${RED}✗ Packaging problem: no packaged app found in dist/$scope${NC}"
    read -p "Press Enter to exit..."; exit 1
  fi
  found=$(find $roots -path "*app.asar.unpacked/node_modules/koffi/build/koffi/${triplet}/koffi.node" 2>/dev/null | head -1 || true)
  if [ -z "$found" ]; then
    echo ""
    echo -e "${RED}✗ Packaging problem: the cache-control binary (koffi, ${triplet}) is missing${NC}"
    echo -e "  from the packaged app. Verification would silently stop reading the"
    echo -e "  medium and read from memory instead. Check asarUnpack/files for this"
    echo -e "  platform in electron-builder.yml."
    read -p "Press Enter to exit..."; exit 1
  fi
  echo -e "${GREEN}✓ Cache-control binary present (${triplet})${NC}"
}

# ── 1. Node.js ──────────────────────────────────────────────────
echo -e "${BLUE}[1/6]${NC} Checking Node.js…"
# Launched from a .command through a non-interactive, non-login bash, which
# never reads ~/.zshrc — where nvm lives. Load it ourselves or a Mac with
# Node 22 under nvm is told "Node.js not found".
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)' >/dev/null 2>&1; }
if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
  echo "  → Loading nvm…"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  \. "$NVM_DIR/nvm.sh" || true
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"
# electron-builder 26 (used since the Electron 43 upgrade) needs Node 20.19+;
# older Nodes crash mid-build with a cryptic "ERR_REQUIRE_ESM @noble/hashes"
# error. nodejs.org's current LTS (22) is fine.
if ! node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)'; then
  echo -e "${RED}✗ Node.js $(node --version) is too old — 20.19 or newer is required (22 LTS recommended).${NC}"
  echo "  → https://nodejs.org  (download the LTS version), then run this script again."
  read -p "Press Enter to exit..."; exit 1
fi

# ── 2. npm ──────────────────────────────────────────────────────
echo -e "${BLUE}[2/6]${NC} Checking npm…"
if ! command -v npm &>/dev/null; then
  echo -e "${RED}✗ npm not found.${NC}"; exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# ── 3. Wine (optionnel — non requis pour NSIS avec electron-builder récent) ─
echo -e "${BLUE}[3/6]${NC} Checking Wine…"
if command -v wine &>/dev/null; then
  echo -e "${GREEN}✓ Wine $(wine --version 2>/dev/null | head -1)${NC}"
else
  echo -e "${YELLOW}⚠ Wine not found — not required for NSIS cross-compile${NC}"
  echo -e "  (Install via Homebrew: ${CYAN}brew install --cask wine-stable${NC} if needed)"
fi

# ── 4. Icône Windows (.ico) ─────────────────────────────────────
echo -e "${BLUE}[4/6]${NC} Checking Windows icon…"
if [ ! -f "$PROJECT_DIR/build-resources/icon.ico" ]; then
  echo -e "${YELLOW}⚠ icon.ico not found — attempting conversion from icon.icns…${NC}"
  if [ -f "$PROJECT_DIR/build-resources/icon.icns" ]; then
    # Convert icns → png → ico using sips + ImageMagick or sips only
    if command -v magick &>/dev/null || command -v convert &>/dev/null; then
      CONV=$(command -v magick || command -v convert)
      TMP_PNG="/tmp/ingesto_icon_256.png"
      sips -s format png "$PROJECT_DIR/build-resources/icon.icns" \
           --resampleHeightWidth 256 256 --out "$TMP_PNG" &>/dev/null
      "$CONV" "$TMP_PNG" \
        \( -clone 0 -resize 256x256 \) \
        \( -clone 0 -resize 128x128 \) \
        \( -clone 0 -resize 64x64 \)  \
        \( -clone 0 -resize 48x48 \)  \
        \( -clone 0 -resize 32x32 \)  \
        \( -clone 0 -resize 16x16 \)  \
        -delete 0 "$PROJECT_DIR/build-resources/icon.ico" 2>/dev/null
      rm -f "$TMP_PNG"
      if [ -f "$PROJECT_DIR/build-resources/icon.ico" ]; then
        echo -e "${GREEN}✓ icon.ico generated from icon.icns${NC}"
      else
        echo -e "${YELLOW}⚠ Conversion failed — build will use default icon${NC}"
      fi
    else
      echo -e "${YELLOW}⚠ ImageMagick not found (brew install imagemagick) — build will use default icon${NC}"
    fi
  else
    echo -e "${YELLOW}⚠ No icon.icns found either — build will use default Electron icon${NC}"
  fi
else
  echo -e "${GREEN}✓ icon.ico ready${NC}"
fi

# ── 5. Dependencies ─────────────────────────────────────────────
echo -e "${BLUE}[5/6]${NC} Installing dependencies…"
# npm ci, not npm install: it installs EXACTLY what package-lock.json pins, so
# two builds carrying the same version number carry the same dependencies —
# koffi included, and cache control depends on koffi. `npm install` is free to
# resolve a newer patch release, which is how two "2.6.1" builds could differ.
# It also refuses to run when the lock and package.json disagree, which is the
# right moment to find that out.
set +e
if [ -f "$PROJECT_DIR/package-lock.json" ]; then
  npm ci --silent 2>&1 | grep -v "^npm warn"
else
  echo -e "${YELLOW}⚠ No package-lock.json — falling back to npm install (this build is not reproducible)${NC}"
  npm install --silent 2>&1 | grep -v "^npm warn"
fi
NPM_STATUS=${PIPESTATUS[0]}
set -e
if [ "$NPM_STATUS" -ne 0 ]; then
  echo -e "${RED}✗ Installing dependencies failed. See error above.${NC}"
  echo -e "${RED}  If npm says the lock file is out of sync, run 'npm install' once and commit package-lock.json.${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Dependencies installed (locked versions)${NC}"

# ── 6. Build ────────────────────────────────────────────────────
# Clear this platform's previous artefacts first, so a failed build can never
# present the previous version's installer as this build's output. Only the
# WINDOWS ones: wiping the whole dist/ also destroyed the Mac build made just
# before, which is exactly what happens when you build both in a row.
rm -rf "$PROJECT_DIR"/dist/*.exe "$PROJECT_DIR"/dist/*.exe.blockmap \
       "$PROJECT_DIR"/dist/win-unpacked "$PROJECT_DIR"/dist/win-* \
       "$PROJECT_DIR"/dist/latest.yml
echo -e "${BLUE}[6/6]${NC} Building ingesto for Windows (x64)…"
echo ""
echo -e "${YELLOW}  Note: electron-builder will download the Windows Electron binary"
echo -e "  (~100 MB) on first run. This is normal.${NC}"
echo ""

set +e
npm run build:win 2>&1 | grep -v "^>" | tail -20
BUILD_STATUS=${PIPESTATUS[0]}
set -e
if [ "$BUILD_STATUS" -ne 0 ]; then
  echo ""
  echo -e "${RED}✗ Build failed. Common causes:${NC}"
  echo -e "  • Network issue downloading Electron Windows binary"
  echo -e "  • Try: ${CYAN}ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run build:win${NC}"
  read -p "Press Enter to exit..."; exit 1
fi

# ── Done ────────────────────────────────────────────────────────
check_koffi win32_x64 'win-unpacked'
EXE_FILES=$(find dist -name "*.exe" 2>/dev/null || true)

# No installer means no build, whatever electron-builder's exit code said.
if [ -z "$EXE_FILES" ]; then
  echo ""
  echo -e "${RED}✗ No .exe found in dist/ — the build did not produce an installer.${NC}"
  read -p "Press Enter to exit..."; exit 1
fi

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}              BUILD SUCCESSFUL! 🎉                    ${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -n "$EXE_FILES" ]; then
  echo -e "${BOLD}Windows installer created:${NC}"
  while IFS= read -r f; do
    SIZE=$(du -sh "$f" 2>/dev/null | cut -f1 || true)
    echo -e "  ${GREEN}→${NC} $f  (${SIZE})"
  done <<< "$EXE_FILES"
fi

echo ""
echo -e "${CYAN}To install on Windows:${NC}"
echo -e "  1. Copy the .exe to a Windows machine"
echo -e "  2. Right-click → Run as administrator (first install)"
echo -e "  3. If Windows Defender blocks it: click 'More info' → 'Run anyway'"
echo -e "     (This happens because the app is unsigned)"
echo ""
echo -e "${YELLOW}To sign the installer (optional, removes Defender warning):${NC}"
echo -e "  Requires a Windows Code Signing certificate (~€200-400/year)"
echo -e "  See: https://www.electron.build/code-signing"
echo ""

read -p "Open the dist folder? (y/n): " OPEN_DIST
[[ "$OPEN_DIST" =~ ^[Yy] ]] && open dist/
echo ""
echo -e "${CYAN}Thank you for using ingesto — by Just Edit${NC}"
echo ""
