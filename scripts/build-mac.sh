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
# ║           ingesto — Build Script for macOS               ║
# ║         Just double-click to build the app!              ║
# ╚══════════════════════════════════════════════════════════╝

set -e
# NOTE: do NOT use `set -o pipefail` here. Every pipeline in this script ends in
# a `grep -v` filter, and grep exits 1 when it filters out EVERY line — which is
# exactly what a clean `npm install --silent` produces. pipefail would turn a
# perfectly successful step into an abort. The real command's status is read
# explicitly through PIPESTATUS instead.

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
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${CYAN}           ingesto — Build for macOS              ${NC}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
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

# ── 1. Check Node.js ──────────────────────────────────────────
echo -e "${BLUE}[1/5]${NC} Checking Node.js…"
# This script is launched from build-mac.command through a NON-interactive,
# NON-login bash, which reads neither ~/.zshrc nor ~/.bashrc — where nvm lives.
# Without this block a Mac whose only Node is nvm-managed (the usual case) was
# told "Node.js not found" while having Node 22 installed.
node_ok() { command -v node >/dev/null 2>&1 && node -e 'const [a,b]=process.versions.node.split(".").map(Number); process.exit(a>20||(a===20&&b>=19)?0:1)' >/dev/null 2>&1; }
if ! node_ok && [ -s "$HOME/.nvm/nvm.sh" ]; then
  echo "  → Loading nvm…"
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1091
  \. "$NVM_DIR/nvm.sh" || true
  nvm use --silent 22 >/dev/null 2>&1 || nvm use --silent node >/dev/null 2>&1 || true
fi
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found!${NC}"
  echo "  → https://nodejs.org  (download the LTS version)"
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

# ── 2. Check npm ──────────────────────────────────────────────
echo -e "${BLUE}[2/5]${NC} Checking npm…"
if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ npm not found!${NC}"; exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# ── 3. Check files ────────────────────────────────────────────
echo -e "${BLUE}[3/5]${NC} Checking required files…"
MISSING=0
[ ! -f "$PROJECT_DIR/build-resources/icon.icns" ] && echo -e "${RED}✗ build-resources/icon.icns not found!${NC}" && MISSING=1
[ ! -f "$PROJECT_DIR/electron-builder.yml" ]       && echo -e "${RED}✗ electron-builder.yml not found!${NC}"      && MISSING=1
[ $MISSING -eq 1 ] && read -p "Press Enter to exit..." && exit 1
echo -e "${GREEN}✓ All required files present${NC}"

# ── 4. Install dependencies ───────────────────────────────────
echo -e "${BLUE}[4/5]${NC} Installing dependencies…"
set +e
npm install --silent 2>&1 | grep -v "^npm warn"
NPM_STATUS=${PIPESTATUS[0]}
set -e
if [ "$NPM_STATUS" -ne 0 ]; then
  echo -e "${RED}✗ Installing dependencies failed. See error above.${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 5. Build DMG ─────────────────────────────────────────────
# Clear this platform's previous artefacts FIRST. Without this, a failed build
# left the previous version's DMG in dist/ and the "Done" screen proudly listed
# it — the operator then shipped the old build believing it was the new one.
#
# Only the MAC artefacts go: wiping the whole dist/ also destroyed a Windows or
# Linux build made earlier the same day, so building all three in a row left you
# with just the last one.
rm -rf "$PROJECT_DIR"/dist/*.dmg "$PROJECT_DIR"/dist/*.dmg.blockmap \
       "$PROJECT_DIR"/dist/mac "$PROJECT_DIR"/dist/mac-* \
       "$PROJECT_DIR"/dist/latest-mac.yml
echo -e "${BLUE}[5/5]${NC} Building ingesto DMG (arm64)…"
set +e
npm run build 2>&1 | grep -v "^>" | grep -v "^\s*$"
BUILD_STATUS=${PIPESTATUS[0]}
set -e
if [ "$BUILD_STATUS" -ne 0 ]; then
  echo -e "${RED}✗ Build failed. See error above.${NC}"
  read -p "Press Enter to exit..."; exit 1
fi

# ── Done ──────────────────────────────────────────────────────
# `|| true`: dist/ is deleted before the build, so find exits 1 when the build
# produced nothing — and `set -e` would kill the script before the message below.
check_koffi darwin_arm64 'mac*'
DMG_FILES=$(find dist -name "*.dmg" 2>/dev/null || true)

if [ -z "$DMG_FILES" ]; then
  echo -e "${RED}✗ No DMG found in dist/ — build may have failed silently.${NC}"
  echo -e "  Check dist/ for errors."
  read -p "Press Enter to exit..."; exit 1
fi

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}              BUILD SUCCESSFUL! 🎉               ${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""
echo -e "${BOLD}DMG created:${NC}"
while IFS= read -r f; do
  SIZE=$(du -sh "$f" 2>/dev/null | cut -f1 || true)
  echo -e "  ${GREEN}→${NC} $f  (${SIZE})"
done <<< "$DMG_FILES"
echo ""
echo -e "${CYAN}To install: open the .dmg, drag ingesto to Applications.${NC}"
echo -e "${CYAN}First launch: right-click → Open (to bypass Gatekeeper).${NC}"
echo ""
read -p "Open the dist folder? (y/n): " OPEN_DIST
[[ "$OPEN_DIST" =~ ^[Yy] ]] && open dist/
echo ""
echo -e "${CYAN}Thank you for using ingesto — by Just Edit${NC}"
echo ""
