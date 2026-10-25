#!/bin/bash
#
# Publishes this folder to GitHub so that the repository becomes its content:
# added, changed AND removed files, except the private tracking files listed
# in PRIVATE below. Launched by push_github.command.
#
# Why this script exists: the GitHub web uploader never deletes a file and
# drops the executable bit of the scripts (it happened, fixed by dd8a2f7 on
# 01.10.2026). Here git itself records the folder, so both are right.
#
# How it works, without touching this folder:
#   1. clones the GitHub repository into a temporary folder;
#   2. reads the version published there and refuses unless this folder's
#      version.json is strictly newer and agrees with package.json;
#   3. lets git compare this folder with the clone (.gitignore applies, so
#      node_modules/ and dist/ stay out), lists the changes, waits for "y";
#   4. holds version.json back until the GitHub Release vX.Y.Z exists with
#      its binaries: installed copies read version.json to offer an update,
#      and must never be sent to an empty release. Run the script again once
#      the release is out to send it;
#   5. commits and pushes normally. Never a forced push: if GitHub moved in
#      the meantime, the push is refused and nothing is lost.

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TMP=""
cleanup() { [ -n "$TMP" ] && rm -rf "$TMP"; }
trap cleanup EXIT

fail() { echo; echo "ARRET : $1"; echo "Rien n'a ete envoye sur GitHub."; exit 1; }

# First "version" key of a JSON file. Enough for version.json and package.json,
# where the app's own version comes before any other "version" key.
read_version() {
  sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$1" | head -n 1
}

# 0 if $1 is strictly greater than $2 (both X.Y.Z).
version_gt() {
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<< "$1"
  IFS=. read -r b1 b2 b3 <<< "$2"
  [ "$a1" -ne "$b1" ] && { [ "$a1" -gt "$b1" ]; return; }
  [ "$a2" -ne "$b2" ] && { [ "$a2" -gt "$b2" ]; return; }
  [ "$a3" -gt "$b3" ]
}

echo "Publication sur GitHub"
echo "Dossier : $ROOT"
echo

command -v git >/dev/null 2>&1 || fail "git est introuvable. Sur Mac : lancer 'xcode-select --install' dans le Terminal, puis relancer ce script."

[ -f "$ROOT/version.json" ] || fail "version.json manque dans le dossier."
[ -f "$ROOT/package.json" ] || fail "package.json manque dans le dossier."

VERSION="$(read_version "$ROOT/version.json")"
PKG_VERSION="$(read_version "$ROOT/package.json")"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "version.json ne contient pas un numero X.Y.Z lisible (lu : '$VERSION')."
[ "$VERSION" = "$PKG_VERSION" ] || fail "version.json dit $VERSION mais package.json dit $PKG_VERSION. Les deux doivent dire le meme numero."

# GitHub address: package.json "repository", otherwise version.json "url".
REPO_URL="$(grep -A3 '"repository"' "$ROOT/package.json" | sed -n 's/.*"url"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -n 1)"
[ -z "$REPO_URL" ] && REPO_URL="$(grep -o 'github\.com/[^"]*' "$ROOT/version.json" | head -n 1)"
SLUG="$(echo "$REPO_URL" | sed -n 's#.*github\.com[/:]\([^/]*\)/\([^/.]*\).*#\1/\2#p')"
[ -n "$SLUG" ] || fail "adresse GitHub introuvable dans package.json (repository) ou version.json (url)."
CLONE_URL="${INGESTO_PUSH_REMOTE:-https://github.com/$SLUG.git}"

echo "Depot GitHub : $SLUG"
echo "Version du dossier : $VERSION"
echo

TMP="$(mktemp -d)"
echo "Copie temporaire du depot..."
git clone --quiet "$CLONE_URL" "$TMP/repo" || fail "impossible de recuperer le depot depuis GitHub (connexion internet, adresse ou droits d'acces)."
GIT=(git --git-dir="$TMP/repo/.git" --work-tree="$ROOT")

if [ -f "$TMP/repo/version.json" ]; then
  PUBLISHED="$(read_version "$TMP/repo/version.json")"
else
  PUBLISHED="0.0.0"
fi
[[ "$PUBLISHED" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail "la version publiee sur GitHub est illisible (lu : '$PUBLISHED')."
echo "Version publiee sur GitHub : $PUBLISHED"
version_gt "$VERSION" "$PUBLISHED" || fail "la version du dossier ($VERSION) n'est pas superieure a celle publiee ($PUBLISHED). Chaque envoi doit porter une nouvelle version."

# Is the release vX.Y.Z out, with at least one binary attached?
RELEASE_OK=""
if [ -n "$INGESTO_PUSH_RELEASE" ]; then
  RELEASE_OK="$INGESTO_PUSH_RELEASE"   # tests only
else
  for TAG in "v$VERSION" "$VERSION"; do
    BODY="$(curl -fsSL "https://api.github.com/repos/$SLUG/releases/tags/$TAG" 2>/dev/null)" || continue
    if echo "$BODY" | grep -q '"browser_download_url"'; then RELEASE_OK="yes"; else RELEASE_OK="empty"; fi
    break
  done
fi

# Stage this folder against the clone: adds, changes and removals at once.
"${GIT[@]}" add -A || fail "git n'a pas pu lire le dossier."
# Files that only concern Noar and the AI working on the project: they travel
# in the ZIP, so the development can be picked up from it, but they are not
# published. Already on GitHub (2.8.0)? They are removed there, and the list
# below shows them as D.
PRIVATE=(CLAUDE.md AGENTS.md ETAT_PROJET.md docs/notes)
"${GIT[@]}" rm -r -q --cached --ignore-unmatch -- "${PRIVATE[@]}" >/dev/null \
  || fail "impossible d'ecarter les fichiers de suivi (${PRIVATE[*]})."
HOLD_VERSION=""
if [ "$RELEASE_OK" != "yes" ]; then
  if ! "${GIT[@]}" diff --cached --quiet -- version.json 2>/dev/null; then
    "${GIT[@]}" reset -q -- version.json
    HOLD_VERSION="yes"
  fi
fi

if "${GIT[@]}" diff --cached --quiet; then
  echo
  if [ -n "$HOLD_VERSION" ]; then
    echo "Le code est deja sur GitHub. Il ne reste que version.json, retenu tant que"
    echo "la Release v$VERSION n'a pas ses binaires sur GitHub."
    echo "Publier la Release, puis relancer ce script."
  else
    echo "Rien a envoyer : GitHub est deja identique a ce dossier."
  fi
  exit 0
fi

echo
echo "Restent hors de GitHub (dans le ZIP seulement) : ${PRIVATE[*]}"
echo
echo "Changements qui vont partir sur GitHub :"
echo "  (A ajoute, M modifie, D supprime, R renomme)"
echo
"${GIT[@]}" diff --cached --name-status -M | sed 's/^/  /'
echo
# A file whose only change is its executable flag is almost always an
# unzipping accident, not a decision: say so before anything leaves.
MODES="$("${GIT[@]}" diff --cached --summary | grep -c 'mode change')"
if [ "$MODES" -gt 0 ]; then
  echo "ATTENTION : $MODES fichier(s) changent seulement de droits d'execution :"
  "${GIT[@]}" diff --cached --summary | grep 'mode change' | sed 's/^ *mode change [0-9]* => \([0-9]*\) /  -> \1 /'
  echo "(100755 = executable, 100644 = normal). Si ce n'est pas voulu, repondre N."
  echo
fi
if [ -n "$HOLD_VERSION" ]; then
  if [ "$RELEASE_OK" = "empty" ]; then
    echo "version.json est RETENU : la Release v$VERSION existe mais n'a encore aucun binaire."
  else
    echo "version.json est RETENU : aucune Release v$VERSION trouvee sur GitHub (ou GitHub n'a pas repondu)."
  fi
  echo "Les applis installees ne verront donc pas encore la mise a jour."
  echo "Une fois la Release publiee avec ses binaires, relancer ce script pour l'envoyer."
  echo
fi

read -r -p "Envoyer ces changements sur GitHub ? (y/N) " ANSWER
[ "$ANSWER" = "y" ] || [ "$ANSWER" = "Y" ] || { echo; echo "Annule. Rien n'a ete envoye."; exit 0; }

if [ -n "$HOLD_VERSION" ]; then
  MESSAGE="Release $VERSION (code, version.json held until the release is out)"
else
  MESSAGE="Release $VERSION"
fi
"${GIT[@]}" commit -q -m "$MESSAGE" || fail "le commit a echoue. Si git demande un nom et un email, lancer dans le Terminal :
  git config --global user.name \"Ton nom\"
  git config --global user.email \"ton@email\""

git --git-dir="$TMP/repo/.git" push --quiet origin HEAD || fail "GitHub a refuse l'envoi (droits d'acces, ou le depot a change entre-temps). Le commit est abandonne."

echo
echo "Envoye. GitHub est a jour en version $VERSION."
[ -n "$HOLD_VERSION" ] && echo "Rappel : version.json reste a envoyer apres la Release (relancer ce script)."
exit 0
