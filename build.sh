#!/bin/bash
# -----------------------------------------------------------------------------
# syncto — Build script (run from macOS)
# -----------------------------------------------------------------------------
#   ./build.sh              macOS Apple Silicon (arm64) .dmg
#   ./build.sh --universal  macOS Universal (arm64 + x86_64) .dmg
#   ./build.sh --win        Windows x64: .zip (always) + NSIS .exe (needs Wine)
#   ./build.sh --all        macOS arm64 + Windows x64
#   ./build.sh --dev        run without building
#   ./build.sh --test       run the engine test suite
#   ./build.sh --sign-check report what the macOS build would be signed with
#                           (the build sets everything up on its own — this is
#                            only here for looking without building)
# -----------------------------------------------------------------------------
# NOTE ON THE WINDOWS BUILD FROM A MAC
#   syncto's own code compiles nothing (hash-wasm is WebAssembly, ssh2 is
#   JavaScript), so cross-building for Windows from macOS IS realistic.
#   ssh2 does declare two OPTIONAL native modules, cpu-features and nan, which
#   npm installs on any Mac that has the Xcode command line tools — and that was
#   enough to stop the Windows build dead:
#       node-gyp does not support cross-compiling native modules from source
#   electron-builder.yml now skips the rebuild pass and leaves both out of the
#   package. ssh2 works without them.
#   The portable .zip needs nothing extra. The NSIS installer (.exe) is produced
#   by Wine — install it once with:  brew install --cask wine-stable
#   The Windows result is unsigned: SmartScreen warns on first launch
#   ("More info" -> "Run anyway").
#
# NOTE ON THE macOS BUILD
#   The build handles signing and notarization ITSELF. Nothing to run first:
#   with a Developer ID Application certificate in the keychain it signs the
#   app, sends it to Apple and staples the ticket to both the app and the disk
#   image, asking for an Apple ID and an app-specific password the FIRST time
#   only. Without a certificate it builds unsigned exactly as before, and a
#   notarization that fails falls back to a signed build rather than to none.
#   scripts/notarize-lib.sh does the work and explains itself.
#   SYNCTO_SKIP_SIGN=1 ./build.sh forces an unsigned build.
# -----------------------------------------------------------------------------

set -e
cd "$(dirname "${BASH_SOURCE[0]}")"

APP="syncto"
VERSION=$(node -e "console.log(require('./package.json').version)" 2>/dev/null || echo "?")

BOLD=$'\033[1m'; CYAN=$'\033[0;36m'; GREEN=$'\033[0;32m'
YELLOW=$'\033[1;33m'; RED=$'\033[0;31m'; NC=$'\033[0m'
BLUE="$CYAN"

# shellcheck source=scripts/notarize-lib.sh
. "./scripts/notarize-lib.sh"

echo ""
echo "${BOLD}${CYAN}  $APP  v$VERSION${NC}"
echo "  ---------------------------------"

if ! command -v node &>/dev/null; then
  echo "${RED}  Node.js not found. Install it from https://nodejs.org${NC}"; exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "  Installing dependencies..."
  npm install
fi

case "$1" in
  --dev)
    echo "  Dev mode..."
    npm run dev
    ;;
  --test)
    echo "  Running engine tests..."
    npm test
    ;;
  --sign-check)
    # Pure diagnostic — reports and asks nothing. The BUILD sets everything up
    # on its own; this is only here for when you want to look without building.
    prepare_signing check_only
    echo "  -> $SIGN_MODE"
    ;;
  --universal)
    echo "  Building macOS Universal..."
    prepare_signing
    build_mac_target build:mac-universal
    staple_dmg "dist/$APP-$VERSION-mac-universal.dmg"
    verify_result "dist/mac-universal/$APP.app" "dist/$APP-$VERSION-mac-universal.dmg"
    echo "${GREEN}  Done -> dist/${NC}"
    ;;
  --win)
    echo "  Building Windows x64 from macOS..."
    if ! command -v wine &>/dev/null && ! command -v wine64 &>/dev/null; then
      echo "${YELLOW}  Wine not found: the NSIS .exe will fail, the .zip will still be produced.${NC}"
      echo "${YELLOW}  Install once with: brew install --cask wine-stable${NC}"
    fi
    npm run build:win
    echo ""
    echo "${GREEN}  Installer: dist/$APP-Setup-$VERSION.exe${NC}"
    echo "${GREEN}  Portable:  dist/$APP-$VERSION-win-x64.zip${NC}"
    ;;
  --all)
    prepare_signing
    build_mac_target build:mac
    staple_dmg "dist/$APP-$VERSION-mac-arm64.dmg"
    verify_result "dist/mac-arm64/$APP.app" "dist/$APP-$VERSION-mac-arm64.dmg"
    npm run build:win
    echo "${GREEN}  Done -> dist/${NC}"
    ;;
  *)
    echo "  Building macOS Apple Silicon (arm64)..."
    prepare_signing
    # The .app is built before the .dmg is wrapped around it. If only the disk
    # image failed, the application is finished — hand it over as a zip instead
    # of reporting a failed build and leaving nothing behind.
    if ! build_mac_target build:mac; then
      if [ -d "dist/mac-arm64/$APP.app" ]; then
        echo "${YELLOW}  The disk image failed; packing the app as a zip instead.${NC}"
        ( cd dist/mac-arm64 && ditto -c -k --sequesterRsrc --keepParent "$APP.app" "../$APP-$VERSION-mac-arm64.zip" )
        echo "${GREEN}  Portable: dist/$APP-$VERSION-mac-arm64.zip${NC}"
        echo ""
        exit 0
      fi
      echo "${RED}  The build failed before the application was produced.${NC}"
      exit 1
    fi
    staple_dmg "dist/$APP-$VERSION-mac-arm64.dmg"
    verify_result "dist/mac-arm64/$APP.app" "dist/$APP-$VERSION-mac-arm64.dmg"
    echo ""
    echo "${GREEN}  Installer: dist/$APP-$VERSION-mac-arm64.dmg${NC}"
    echo "  Open the .dmg, drag $APP into Applications."
    case "$SIGN_MODE" in
      notarized) echo "${GREEN}  Signed and notarized: a plain double-click on any Mac.${NC}" ;;
      signed)    echo "${YELLOW}  Signed, NOT notarized: another Mac will warn. Right-click -> Open.${NC}" ;;
      *)         echo "${YELLOW}  First launch (unsigned): right-click $APP -> Open.${NC}" ;;
    esac
    ;;
esac
echo ""
