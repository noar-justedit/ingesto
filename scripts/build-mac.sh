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

# ── Signing identity ─────────────────────────────────────────────────────────
# ingesto is open source: it MUST build without an Apple Developer account.
# So signing is detected, never required. With a Developer ID certificate the
# build is signed and notarized and opens on any Mac; without one it is built
# unsigned exactly as before, and the final message says so instead of pretending.
#
# `-p codesigning` is the important flag: a certificate imported without its
# private key still shows up elsewhere but cannot sign — the single most common
# way a signing setup looks correct and is not.
SIGN_ID=""
detect_identity() {
  # Certificates listed with "(Missing required extension)" (or revoked /
  # expired mentions) are REJECTED by electron-builder's own identity search:
  # counting one here would announce "Signing as: …" over a build that comes
  # out unsigned. The sed -n form returns EMPTY when the line carries no
  # quoted name, instead of passing the raw line off as a certificate name.
  SIGN_ID=$(security find-identity -v -p codesigning 2>/dev/null \
            | grep "Developer ID Application" \
            | grep -viE "Missing required extension|CSSMERR|REVOKED|EXPIRED" \
            | head -1 \
            | sed -nE 's/.*"(.*)".*/\1/p' || true)
}

NOTARY_PROFILE="${INGESTO_NOTARY_PROFILE:-ingesto-notarization}"

# ── 1. Check Node.js ──────────────────────────────────────────
echo -e "${BLUE}[1/6]${NC} Checking Node.js…"
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
echo -e "${BLUE}[2/6]${NC} Checking npm…"
if ! command -v npm &> /dev/null; then
  echo -e "${RED}✗ npm not found!${NC}"; exit 1
fi
echo -e "${GREEN}✓ npm $(npm --version)${NC}"

# ── 3. Check files ────────────────────────────────────────────
echo -e "${BLUE}[3/6]${NC} Checking required files…"
MISSING=0
[ ! -f "$PROJECT_DIR/build-resources/icon.icns" ] && echo -e "${RED}✗ build-resources/icon.icns not found!${NC}" && MISSING=1
[ ! -f "$PROJECT_DIR/electron-builder.yml" ]       && echo -e "${RED}✗ electron-builder.yml not found!${NC}"      && MISSING=1
if [ $MISSING -eq 1 ]; then read -p "Press Enter to exit..."; exit 1; fi
echo -e "${GREEN}✓ All required files present${NC}"

# ── 4. Install dependencies ───────────────────────────────────
echo -e "${BLUE}[4/6]${NC} Installing dependencies…"
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
echo -e "${BLUE}[5/6]${NC} Building ingesto DMG (arm64)…"
detect_identity
if [ -n "$SIGN_ID" ]; then
  echo -e "  ${CYAN}Signing as:${NC} $SIGN_ID"
  if [ "${INGESTO_SKIP_NOTARIZE:-0}" = "1" ]; then
    echo -e "  ${YELLOW}Notarization disabled (INGESTO_SKIP_NOTARIZE=1) — local test build only.${NC}"
  else
    echo -e "  ${CYAN}Notarizing with keychain profile:${NC} $NOTARY_PROFILE"
    # Ask Apple, NOW, whether these credentials work — before spending ten
    # minutes packaging an app that would be rejected at the very last step.
    # Same principle as the ingest itself: check the conditions before starting,
    # rather than failing at the end with nothing to show for it.
    # This also validates the credentials, not merely the presence of a profile.
    echo -e "  ${CYAN}Checking the notarization credentials…${NC}"
    set +e
    NOTARY_CHECK=$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1)
    NOTARY_RC=$?
    set -e
    # "No submission history" is the normal answer before the very first
    # notarization — the credentials are fine, there is simply nothing to list.
    # Treating a non-zero exit as a failure here would block the first signed
    # build of every new account, which is precisely when this check has to work.
    if echo "$NOTARY_CHECK" | grep -qi "no submission history"; then
      NOTARY_RC=0
    fi
    if [ "$NOTARY_RC" -ne 0 ]; then
      echo ""
      echo -e "${RED}✗ Apple refused these notarization credentials — nothing was built.${NC}"
      echo ""
      echo "$NOTARY_CHECK" | sed 's/^/    /'
      echo ""
      echo -e "  ${BOLD}To create the profile (it is stored in your keychain, not in any file):${NC}"
      echo -e "    xcrun notarytool store-credentials"
      echo ""
      echo -e "  It asks, in order: a profile name — type ${BOLD}${NOTARY_PROFILE}${NC} —, then leave the"
      echo -e "  API key path EMPTY, then your Apple Developer address, then the"
      echo -e "  app-specific password from appleid.apple.com, then your Team ID."
      if [ -n "$SIGN_ID" ]; then
        TEAM_ID=$(echo "$SIGN_ID" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')
        echo -e "  Your Team ID, taken from the certificate above: ${BOLD}${TEAM_ID}${NC}"
      fi
      echo ""
      echo -e "  An app-specific password is shown ${BOLD}once${NC}. If you no longer have it,"
      echo -e "  delete it at appleid.apple.com and create another."
      echo ""
      echo -e "  Then run this build again. To build without notarizing meanwhile:"
      echo -e "    INGESTO_SKIP_NOTARIZE=1 bash scripts/build-mac.sh"
      echo ""
      read -p "Press Enter to exit..."; exit 1
    fi
    echo -e "${GREEN}✓ Notarization credentials accepted by Apple${NC}"
    echo -e "  ${YELLOW}Apple's check adds a few minutes once the app is packaged.${NC}"
  fi
else
  echo -e "  ${YELLOW}No Developer ID certificate found — building UNSIGNED.${NC}"
  echo -e "  ${YELLOW}Fine for your own machine; this build will be blocked on any other Mac.${NC}"
fi
set +e
# --line-buffered is NOT cosmetic. Without it grep buffers by block, and the
# build appears FROZEN: electron-builder's lines, and above all notarytool's
# "In Progress" heartbeat, sit in a 4 KB buffer for the ten to twenty minutes
# Apple takes. The first signed build looked hung for exactly this reason.
npm run build 2>&1 | grep --line-buffered -v "^>" | grep --line-buffered -v "^[[:space:]]*$"
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
# maxdepth 1: the clean-up above only clears the ROOT of dist/, so a DMG
# archived in a sub-folder must never be picked up here — it would be
# notarized, stapled and listed as today's build.
DMG_FILES=$(find dist -maxdepth 1 -name "*.dmg" 2>/dev/null || true)

if [ -z "$DMG_FILES" ]; then
  echo -e "${RED}✗ No DMG found in dist/ — build may have failed silently.${NC}"
  echo -e "  Check dist/ for errors."
  read -p "Press Enter to exit..."; exit 1
fi

# ── 6. Notarize the disk image, then prove the result ────────────────────────
# The APP was already notarized and stapled by scripts/notarize.js, before the
# disk image was built around it. This second pass covers the .dmg itself, so
# the file the user actually downloads carries its own ticket and opens without
# a network round-trip.
#
# Then everything is VERIFIED rather than assumed. A build script that says
# "SUCCESSFUL" over an app macOS will refuse is worse than one that fails.
echo -e "${BLUE}[6/6]${NC} Signature and notarization…"
APP_PATH=$(find dist/mac* -maxdepth 1 -name "*.app" 2>/dev/null | head -1 || true)

if [ -z "$SIGN_ID" ]; then
  echo -e "${YELLOW}⚠ Unsigned build — nothing to verify.${NC}"
  SIGNED_OK=0
elif [ "${INGESTO_SKIP_NOTARIZE:-0}" = "1" ]; then
  # "Signed" is VERIFIED, never assumed: a certificate in the keychain does not
  # mean electron-builder used it (its own filters can reject one this script's
  # detection accepted). Without this check, this branch once printed "Signed"
  # over an app carrying no signature at all.
  if codesign --verify --deep --strict "$APP_PATH" >/dev/null 2>&1; then
    echo -e "${YELLOW}⚠ Signed but NOT notarized (INGESTO_SKIP_NOTARIZE=1) — local test build only.${NC}"
  else
    echo -e "${RED}⚠ NOT SIGNED — electron-builder did not use the certificate this script detected.${NC}"
    echo -e "  Check: security find-identity -v -p codesigning"
  fi
  SIGNED_OK=0
else
  SIGNED_OK=1

  # The signature itself, seals included, all the way down the bundle.
  if codesign --verify --deep --strict --verbose=2 "$APP_PATH" 2>&1 | grep -q "satisfies its Designated Requirement"; then
    echo -e "${GREEN}✓ Signature valid, whole bundle${NC}"
  else
    echo -e "${RED}✗ The signature does not verify. Details:${NC}"
    codesign --verify --deep --strict --verbose=2 "$APP_PATH" || true
    read -p "Press Enter to exit..."; exit 1
  fi

  # The app carries its own ticket (stapled by the afterSign hook).
  if xcrun stapler validate "$APP_PATH" >/dev/null 2>&1; then
    echo -e "${GREEN}✓ Notarization ticket stapled into the app${NC}"
  else
    echo -e "${RED}✗ No notarization ticket in the app — it would be refused on another Mac.${NC}"
    read -p "Press Enter to exit..."; exit 1
  fi

  # Gatekeeper's own verdict, which is the one that counts.
  SPCTL=$(spctl -a -vvv "$APP_PATH" 2>&1 || true)
  if echo "$SPCTL" | grep -q "source=Notarized Developer ID"; then
    echo -e "${GREEN}✓ Gatekeeper accepts the app (Notarized Developer ID)${NC}"
  else
    echo -e "${RED}✗ Gatekeeper does not accept the app:${NC}"
    echo "$SPCTL"
    read -p "Press Enter to exit..."; exit 1
  fi

  # Same treatment for the disk image the user downloads.
  while IFS= read -r dmg; do
    [ -z "$dmg" ] && continue
    echo -e "  ${CYAN}Notarizing the disk image…${NC}"
    if ! xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait; then
      echo -e "${RED}✗ Notarizing the disk image failed.${NC}"
      echo -e "  Apple's reason: xcrun notarytool log <submission-id> --keychain-profile \"$NOTARY_PROFILE\""
      # </dev/tty: inside this loop stdin is the DMG list itself, already
      # consumed — a bare read would sail through and the pause would be lost.
      read -p "Press Enter to exit..." </dev/tty || true; exit 1
    fi
    xcrun stapler staple "$dmg" >/dev/null 2>&1 || true
    if xcrun stapler validate "$dmg" >/dev/null 2>&1; then
      echo -e "${GREEN}✓ Disk image notarized and stapled${NC}"
    else
      echo -e "${RED}✗ The ticket could not be stapled to the disk image.${NC}"
      read -p "Press Enter to exit..." </dev/tty || true; exit 1
    fi
    # The app got Gatekeeper's own verdict above; the DMG — the one file the
    # user actually downloads — deserves the same question, not just a ticket
    # check. `-t open` with the primary-signature context is how Gatekeeper
    # evaluates a downloaded disk image.
    #
    # BUT THIS ONE IS ADVISORY, NOT A GATE. It asks Gatekeeper to evaluate the
    # image's OWN CODE SIGNATURE, and a disk image does not have to carry one:
    # `dmg.sign` is off by default in electron-builder, and 2.5.5 was first
    # built that way. The result was "no usable signature" on an image Apple had
    # just accepted and whose ticket was correctly stapled — a build stopped in
    # red over an artefact that was perfectly good, and that a real download
    # test had already proved opens with a double-click.
    #
    # What actually protects the user is the notarization ticket, and that has
    # been verified above and IS a gate. So: signed image → full verdict; image
    # without its own signature but with its ticket → say so plainly and carry
    # on. Never fail the build for the absence of something optional.
    DMG_SPCTL=$(spctl -a -t open --context context:primary-signature -vvv "$dmg" 2>&1 || true)
    if echo "$DMG_SPCTL" | grep -q "accepted"; then
      echo -e "${GREEN}✓ Gatekeeper accepts the disk image${NC}"
    elif echo "$DMG_SPCTL" | grep -qi "no usable signature"; then
      echo -e "${YELLOW}· Disk image carries no signature of its own — notarized and stapled only.${NC}"
      echo -e "  ${YELLOW}Valid for distribution; set 'sign: true' under 'dmg:' to add one.${NC}"
    else
      echo -e "${YELLOW}· Gatekeeper could not assess the disk image:${NC}"
      echo "$DMG_SPCTL" | sed 's/^/    /'
      echo -e "  ${YELLOW}The ticket above is what counts; treat this as information.${NC}"
    fi
  done <<< "$DMG_FILES"
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
if [ "${SIGNED_OK:-0}" = "1" ]; then
  echo -e "${GREEN}Signed and notarized: it opens with a double-click, on any Mac.${NC}"
  echo ""
  echo -e "${YELLOW}One test still matters:${NC} put this DMG online, download it on ANOTHER Mac"
  echo -e "and open it there. The quarantine flag Gatekeeper inspects is only set on a"
  echo -e "file that was really downloaded — opening it from this folder proves nothing."
else
  echo -e "${YELLOW}First launch: right-click → Open (to bypass Gatekeeper).${NC}"
fi
echo ""
read -p "Open the dist folder? (y/n): " OPEN_DIST || true
if [[ "$OPEN_DIST" =~ ^[Yy] ]]; then open dist/ || true; fi
echo ""
echo -e "${CYAN}Thank you for using ingesto — by Just Edit${NC}"
echo ""
