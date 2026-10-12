#!/bin/bash
#
# Double-click launcher for push_github.sh: publishes this folder to GitHub
# from Finder. The logic lives in push_github.sh; this file only makes it
# double-clickable and keeps the window open so you can read the result.
#
cd "$(dirname "$0")"
# A ZIP or a download can lose the executable flag; restore it and run the
# script through bash so it works regardless.
chmod +x ./*.sh 2>/dev/null
bash ./push_github.sh
status=$?
echo
if [ $status -ne 0 ]; then
  echo "Arret (code $status). Voir les messages ci-dessus."
fi
read -p "Appuyer sur Entree pour fermer cette fenetre..." _
