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

# ── 1. Node.js ──────────────────────────────────────────────────
echo -e "${BLUE}[1/6]${NC} Checking Node.js…"
if ! command -v node &>/dev/null; then
  echo -e "${RED}✗ Node.js not found. Install from https://nodejs.org${NC}"
  read -p "Press Enter to exit..."; exit 1
fi
echo -e "${GREEN}✓ Node.js $(node --version)${NC}"

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
npm install --silent 2>&1 | grep -v "^npm warn" || true
echo -e "${GREEN}✓ Dependencies installed${NC}"

# ── 6. Build ────────────────────────────────────────────────────
echo -e "${BLUE}[6/6]${NC} Building ingesto for Windows (x64)…"
echo ""
echo -e "${YELLOW}  Note: electron-builder will download the Windows Electron binary"
echo -e "  (~100 MB) on first run. This is normal.${NC}"
echo ""

npm run build:win 2>&1 | grep -v "^>" | tail -20 || {
  echo ""
  echo -e "${RED}✗ Build failed. Common causes:${NC}"
  echo -e "  • Network issue downloading Electron Windows binary"
  echo -e "  • Try: ${CYAN}ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run build:win${NC}"
  read -p "Press Enter to exit..."; exit 1
}

# ── Done ────────────────────────────────────────────────────────
EXE_FILES=$(find dist -name "*.exe" 2>/dev/null)

echo ""
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${BOLD}${GREEN}              BUILD SUCCESSFUL! 🎉                    ${NC}"
echo -e "${BOLD}${GREEN}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

if [ -n "$EXE_FILES" ]; then
  echo -e "${BOLD}Windows installer created:${NC}"
  while IFS= read -r f; do
    SIZE=$(du -sh "$f" 2>/dev/null | cut -f1)
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
