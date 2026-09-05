#!/bin/bash
#
# syncto — Folder comparison and synchronization
# Copyright (C) 2026 Just Edit (Arnaud Augst)
# Licensed under the GNU General Public License v3.0 or later.
#
# ── Signing and notarization, handled by the macOS build itself ──────────────
#
# There is nothing to run before the build. `prepare_signing` checks everything,
# asks for what is missing the first time, and from then on the build is signed,
# notarized and stapled without a single question.
#
# What the three words mean, because they are not the same thing:
#
#   SIGN        stamps the application with your Developer ID certificate, so
#               macOS can tell it has not been modified since you built it.
#   NOTARIZE    uploads it to Apple, which scans it and returns a ticket. This
#               is what stops "Apple could not verify syncto is free of
#               malware" on someone else's Mac.
#   STAPLE      attaches that ticket to the file, so the first launch works
#               even with no internet connection.
#
# Nothing is stored in the repository. The certificate lives in your keychain;
# the app-specific password is put into the keychain once, by
# `xcrun notarytool store-credentials`, and read from there afterwards.
#
# Anything missing → the build still runs and produces an unsigned application.
# Signing is never allowed to be the reason you end up with no build.

NOTARY_PROFILE="${SYNCTO_NOTARY_PROFILE:-syncto-notarization}"

# Fills SIGN_IDENTITY and SIGN_TEAM_ID when a Developer ID Application
# certificate is installed. Returns 1 when there is none.
find_signing_identity() {
  SIGN_IDENTITY=""
  SIGN_TEAM_ID=""
  command -v security &>/dev/null || return 1

  # A line looks like:
  #   2) A1B2C3... "Developer ID Application: Arnaud Augst (ABCDE12345)"
  local line
  line=$(security find-identity -v -p codesigning 2>/dev/null \
         | grep "Developer ID Application" | head -1) || return 1
  [ -n "$line" ] || return 1

  SIGN_IDENTITY=$(echo "$line" | sed -E 's/.*"(.*)"$/\1/')
  # The team id is the code in the last parentheses of the certificate name.
  SIGN_TEAM_ID=$(echo "$SIGN_IDENTITY" | sed -E 's/.*\(([A-Z0-9]+)\)$/\1/')
  [ -n "$SIGN_IDENTITY" ] || return 1
  return 0
}

# Are usable notarization credentials stored under that profile name?
#
# `notarytool history` is the cheapest question that reaches Apple. It takes
# authentication options and NOTHING else — no --limit, no --page. Passing one
# makes notarytool reject the command line before it ever contacts Apple, and
# with the output thrown away that is indistinguishable from "your password is
# wrong": every build comes out signed but not notarized, whatever the
# credentials are. Do not add a flag here without checking notarytool(1).
#
# So: ask, and when the answer is no, fall back to asking the keychain whether
# the profile exists at all. notarytool's own command line has changed between
# Xcode versions, and a build should not lose its notarization because a flag
# moved. If the credentials really are bad, the submission fails later and
# build_mac_target falls back — which is the safety net that belongs here,
# rather than a fragile pre-flight refusing a perfectly good build.
#
# NOTARY_ERROR carries the reason, for whoever has to read the output.
notary_profile_ready() {
  NOTARY_ERROR=""
  command -v xcrun &>/dev/null || { NOTARY_ERROR="xcrun not found"; return 1; }

  NOTARY_CONFIRMED=""
  local out
  if out=$(xcrun notarytool history --keychain-profile "$NOTARY_PROFILE" 2>&1); then
    NOTARY_CONFIRMED="apple"
    return 0
  fi
  NOTARY_ERROR=$(echo "$out" | grep -v '^[[:space:]]*$' | head -2 | tr '\n' ' ')

  # Stored, but notarytool would not answer just now. Trust the stored profile
  # and say plainly that Apple was not reached — claiming Apple accepted them
  # would be a lie, and it is the sort of lie that wastes an afternoon later.
  if security find-generic-password -s "com.apple.gke.notary.tool" \
       -a "$NOTARY_PROFILE" &>/dev/null; then
    NOTARY_CONFIRMED="keychain"
    return 0
  fi
  return 1
}

# Asks for the Apple ID and the app-specific password ONCE and hands them to
# the keychain. Never echoes the password, never writes it to a file.
store_notary_credentials() {
  local team_id="$1"
  echo ""
  echo -e "${BOLD}First signed build — two questions, once${NC}"
  echo "  Apple needs two things that are not in your keychain yet:"
  echo "    • your Apple ID (the e-mail of your developer account)"
  echo "    • an app-specific password"
  echo ""
  echo -e "  ${BOLD}An app-specific password is NOT your Apple ID password.${NC} You make"
  echo "  one at appleid.apple.com → Sign-In and Security → App-Specific"
  echo "  Passwords. It looks like abcd-efgh-ijkl-mnop."
  echo ""
  echo "  Both go straight into your macOS keychain under the name"
  echo "  \"$NOTARY_PROFILE\". They are never written into this project, so"
  echo "  they cannot end up in a zip you hand to someone."
  echo ""
  echo "  Leave a line empty to skip: the build carries on unsigned."
  echo ""

  local apple_id
  read -r -p "  Apple ID: " apple_id
  [ -n "$apple_id" ] || { echo -e "${YELLOW}  Skipped.${NC}"; return 1; }

  local app_pw
  read -r -s -p "  App-specific password: " app_pw
  echo ""
  [ -n "$app_pw" ] || { echo -e "${YELLOW}  Skipped.${NC}"; return 1; }

  echo "  Checking with Apple…"
  # store-credentials validates against Apple before it writes anything, so its
  # exit code IS the verdict. Nothing else needs to confirm it: a second check
  # bolted on here can only ever throw away credentials Apple just accepted.
  local out
  if out=$(xcrun notarytool store-credentials "$NOTARY_PROFILE" \
             --apple-id "$apple_id" --team-id "$team_id" --password "$app_pw" 2>&1); then
    echo -e "${GREEN}  ✓ Stored in the keychain. You will never be asked again.${NC}"
    return 0
  fi

  echo -e "${YELLOW}  ✗ Apple refused those credentials.${NC}"
  echo "$out" | grep -v '^[[:space:]]*$' | head -3 | sed 's/^/    /'
  echo "    The three things that are usually wrong:"
  echo "      • it was the Apple ID password, not an app-specific one;"
  echo "      • the Apple ID does not belong to team $team_id;"
  echo "      • the paid Developer Program membership has lapsed — a"
  echo "        certificate outlives it, and notarization stops working while"
  echo "        signing still appears to."
  return 1
}

# Everything the build needs to know about signing, decided here.
#
#   SIGN_MODE=notarized   signed, notarized and stapled
#   SIGN_MODE=signed      signed only
#   SIGN_MODE=unsigned    no certificate, or deliberately skipped
#
# electron-builder needs no configuration for any of it: it discovers the
# certificate on its own, and notarizes when APPLE_KEYCHAIN_PROFILE is set.
#
# `check_only=1` as the first argument turns this into a pure diagnostic: it
# reports and asks nothing.
prepare_signing() {
  local check_only="${1:-}"
  SIGN_MODE="unsigned"

  # ── Deliberately off ──────────────────────────────────────────
  if [ "$SYNCTO_SKIP_SIGN" = "1" ]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    echo -e "${YELLOW}⚠ SYNCTO_SKIP_SIGN=1 — building unsigned on purpose${NC}"
    return 0
  fi

  if [ "$(uname)" != "Darwin" ]; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    return 0
  fi

  # ── The certificate ───────────────────────────────────────────
  # "Developer ID Application" is the only kind that works outside the App
  # Store. An Apple Development certificate signs the app perfectly and is then
  # refused by every other Mac — so when that is all there is, say so by name
  # instead of reporting a vague "no certificate".
  if ! find_signing_identity; then
    export CSC_IDENTITY_AUTO_DISCOVERY=false
    echo -e "${YELLOW}⚠ No Developer ID Application certificate — building unsigned.${NC}"
    if security find-identity -v -p codesigning 2>/dev/null | grep -q '"'; then
      echo "  Certificates in your keychain:"
      security find-identity -v -p codesigning 2>/dev/null | grep '"' | sed 's/^/    /'
      echo -e "  ${YELLOW}None of those will do: only a ${BOLD}Developer ID Application${NC}${YELLOW}"
      echo -e "  certificate is accepted outside the App Store.${NC}"
    fi
    echo "  Get one at developer.apple.com → Certificates, Identifiers & Profiles"
    echo "  → Certificates → + → Developer ID Application, then double-click the"
    echo "  downloaded .cer. The next build picks it up on its own."
    return 0
  fi

  SIGN_MODE="signed"
  echo -e "${GREEN}✓ Certificate: $SIGN_IDENTITY${NC}"

  # ── Apple's command line tools ────────────────────────────────
  # notarytool ships with them. Without them the failure looks like a
  # credentials problem, which sends you looking in the wrong place.
  if ! xcrun --find notarytool &>/dev/null; then
    echo -e "${YELLOW}⚠ Apple's command line tools are missing, so the build cannot be${NC}"
    echo -e "${YELLOW}  notarized. Install them once and the next build will be:${NC}"
    echo -e "      ${BOLD}xcode-select --install${NC}"
    echo "  (Xcode installed but this still fails:"
    echo "      sudo xcode-select -s /Applications/Xcode.app/Contents/Developer)"
    return 0
  fi

  # ── The credentials ───────────────────────────────────────────
  if notary_profile_ready; then
    export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
    SIGN_MODE="notarized"
    if [ "$NOTARY_CONFIRMED" = "apple" ]; then
      echo -e "${GREEN}✓ Notarization ready — Apple accepts the stored credentials${NC}"
    else
      echo -e "${GREEN}✓ Notarization credentials found in the keychain${NC}"
      echo "  Apple could not be reached to confirm them just now, so the build"
      echo "  goes ahead with them; if the submission is refused it falls back to"
      echo "  a signed build rather than failing."
      [ -n "$NOTARY_ERROR" ] && echo "  ($NOTARY_ERROR)"
    fi
    return 0
  fi

  if [ "$check_only" = "check_only" ]; then
    echo -e "${YELLOW}⚠ No usable notarization credentials yet. The next build will ask.${NC}"
    [ -n "$NOTARY_ERROR" ] && echo "  notarytool said: $NOTARY_ERROR"
    return 0
  fi

  if [ ! -t 0 ]; then
    echo -e "${YELLOW}⚠ No notarization credentials, and nothing to type into — building${NC}"
    echo -e "${YELLOW}  signed but not notarized. Run the build from a terminal or by${NC}"
    echo -e "${YELLOW}  double-clicking it to set them up.${NC}"
    return 0
  fi

  # No second opinion: store-credentials already asked Apple. Adding a check
  # here only creates a way to lose credentials that are known to be good.
  if store_notary_credentials "$SIGN_TEAM_ID"; then
    export APPLE_KEYCHAIN_PROFILE="$NOTARY_PROFILE"
    SIGN_MODE="notarized"
    echo -e "${GREEN}✓ Notarization ready${NC}"
    return 0
  fi

  echo -e "${YELLOW}  Carrying on signed but NOT notarized: it runs on your Mac, and${NC}"
  echo -e "${YELLOW}  other Macs will say Apple could not check it for malware.${NC}"
  return 0
}

# Runs the electron-builder script, and never lets Apple cost you the build.
#
# Notarization is the one step that depends on a company on the other side of
# the internet answering. When it is what failed — Apple down, Wi-Fi dropped,
# a submission rejected — building again without it gets you a working, signed
# application instead of an empty dist/ and a wasted evening.
build_mac_target() {
  local npm_script="$1"
  if npm run "$npm_script"; then return 0; fi

  if [ "$SIGN_MODE" != "notarized" ]; then return 1; fi

  echo ""
  echo -e "${YELLOW}⚠ The build failed with notarization switched on.${NC}"
  echo -e "${YELLOW}  Trying once more without it, so you at least get a signed app.${NC}"
  echo ""
  unset APPLE_KEYCHAIN_PROFILE
  SIGN_MODE="signed"
  npm run "$npm_script"
}

# The .app inside the disk image is notarized and stapled by electron-builder.
# The disk image ITSELF is a separate file that Gatekeeper checks when it is
# downloaded, so it needs its own trip to Apple. Without this, the first launch
# from a freshly downloaded .dmg goes online to ask about the ticket — and
# fails on a shoot with no network, which is exactly where syncto gets used.
staple_dmg() {
  local dmg="$1"
  [ -f "$dmg" ] || return 0
  [ "$SIGN_MODE" = "notarized" ] || return 0

  echo -e "${BLUE}      Notarizing the disk image itself…${NC}"
  if ! xcrun notarytool submit "$dmg" --keychain-profile "$NOTARY_PROFILE" --wait; then
    echo -e "${YELLOW}      ⚠ Apple did not accept the disk image. The application inside it${NC}"
    echo -e "${YELLOW}        is still notarized, so it works — the first launch just needs${NC}"
    echo -e "${YELLOW}        an internet connection.${NC}"
    return 0
  fi
  if xcrun stapler staple "$dmg"; then
    echo -e "${GREEN}      ✓ Ticket attached — the first launch works offline${NC}"
  else
    echo -e "${YELLOW}      ⚠ The ticket could not be attached to the disk image.${NC}"
  fi
}

# Says out loud what a stranger's Mac will do with this file. Worth the four
# seconds: a build that is signed but not notarized looks perfect locally and
# is refused on every other machine.
verify_result() {
  local app="$1" dmg="$2"
  [ -d "$app" ] || return 0
  echo ""
  echo -e "${BOLD}Verification${NC}"

  if codesign --verify --deep --strict "$app" &>/dev/null; then
    echo -e "${GREEN}  ✓ signature valid${NC}"
  else
    echo -e "${YELLOW}  ⚠ the application is not signed${NC}"
  fi
  # This is the one that matters: spctl answers the question Gatekeeper will
  # ask on someone else's machine.
  if spctl -a -vv -t exec "$app" 2>&1 | grep -q "accepted"; then
    echo -e "${GREEN}  ✓ Gatekeeper accepts it — no warning on another Mac${NC}"
  else
    echo -e "${YELLOW}  ⚠ Gatekeeper would warn on another Mac${NC}"
  fi
  if xcrun stapler validate "$app" &>/dev/null; then
    echo -e "${GREEN}  ✓ notarization ticket attached to the app${NC}"
  fi
  if [ -f "$dmg" ] && xcrun stapler validate "$dmg" &>/dev/null; then
    echo -e "${GREEN}  ✓ notarization ticket attached to the disk image${NC}"
  fi
}
