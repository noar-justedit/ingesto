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

# ── 1. Check Node.js ──────────────────────────────────────────
echo -e "${BLUE}[1/5]${NC} Checking Node.js…"
if ! command -v node &> /dev/null; then
  echo -e "${RED}✗ Node.js not found!${NC}"
  echo "  → https://nodejs.org  (download the LTS version)"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

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
npm install --silent 2>&1 | grep -v "^npm warn" || true
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 5. Build DMG ─────────────────────────────────────────────
echo -e "${BLUE}[5/5]${NC} Building ingesto DMG (arm64)…"
npm run build 2>&1 | grep -v "^>" | grep -v "^\s*$" || {
  echo -e "${RED}✗ Build failed. See error above.${NC}"
  read -p "Press Enter to exit..."; exit 1
}

# ── Done ──────────────────────────────────────────────────────
DMG_FILES=$(find dist -name "*.dmg" 2>/dev/null)

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
  SIZE=$(du -sh "$f" 2>/dev/null | cut -f1)
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
