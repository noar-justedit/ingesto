#!/bin/bash
#
# syncto — Folder comparison and synchronization
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
# ║        syncto — Build Windows (.exe) from macOS              ║
# ║        Produces an NSIS 64-bit installer + a .zip            ║
# ╚══════════════════════════════════════════════════════════════╝
#
# Cross-building syncto for Windows from a Mac is fully supported: syncto's own
# code compiles nothing (hash-wasm is WebAssembly, ssh2 is JavaScript), so
# nothing needs a Windows compiler.
#
# One trap, and it stopped this build dead until 0.5.5: ssh2 declares two
# OPTIONAL native modules, cpu-features and nan. npm installs them on any Mac
# that has the Xcode command line tools, electron-builder then tries to rebuild
# them for win32-x64 before packaging, and node-gyp cannot cross-compile:
#     ⨯ node-gyp does not support cross-compiling native modules from source
# electron-builder.yml sets npmRebuild: false and excludes both from the
# package. ssh2 loads without them.
#
#   - the portable .zip needs nothing extra
#   - the .exe installer is assembled by Wine:  brew install --cask wine-stable

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."
cd "$PROJECT_DIR"

VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

echo ""
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${CYAN}    syncto v$VERSION — Build Windows installer from macOS ${NC}"
echo -e "${BOLD}${CYAN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# ── 1. Node.js ──────────────────────────────────────────────────
echo -e "${BLUE}[1/4]${NC} Checking Node.js…"
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install it from https://nodejs.org${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

# ── 2. Dependencies ─────────────────────────────────────────────
echo -e "${BLUE}[2/4]${NC} Checking dependencies…"
if [ ! -d "node_modules" ]; then
  echo "      First run — downloading dependencies (2-3 minutes)…"
  npm install
fi
echo -e "${GREEN}✓ Dependencies ready${NC}"

# ── 3. Wine (needed only for the .exe installer) ────────────────
echo -e "${BLUE}[3/4]${NC} Checking Wine…"
if command -v wine &>/dev/null || command -v wine64 &>/dev/null; then
  echo -e "${GREEN}✓ Wine found — the NSIS .exe will be built${NC}"
else
  echo -e "${YELLOW}⚠ Wine not found. The portable .zip will still build fine.${NC}"
  echo -e "${YELLOW}  For the .exe installer, install Wine once:${NC}"
  echo -e "${YELLOW}      brew install --cask wine-stable${NC}"
fi

# ── 4. Build ────────────────────────────────────────────────────
echo -e "${BLUE}[4/4]${NC} Building for Windows x64…"
npm run build:win
echo ""
echo -e "${GREEN}✓ Done.${NC}"
echo ""
echo -e "  ${BOLD}Installer:${NC}  dist/syncto-Setup-$VERSION.exe    (NSIS)"
echo -e "  ${BOLD}Portable:${NC}   dist/syncto-$VERSION-win-x64.zip"
echo ""
echo -e "  ${YELLOW}The build is unsigned: Windows SmartScreen will warn on first${NC}"
echo -e "  ${YELLOW}launch — «More info» → «Run anyway». Expected.${NC}"
echo ""

if [ -t 0 ]; then
  read -p "Open the dist/ folder now? [Y/n] " answer
  if [ "$answer" != "n" ] && [ "$answer" != "N" ]; then open dist/ 2>/dev/null || true; fi
fi
