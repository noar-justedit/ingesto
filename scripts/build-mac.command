#!/bin/bash
#
# Double-click launcher for build-mac.sh — lets you run the Mac build from
# Finder instead of a terminal. The actual build logic lives in build-mac.sh;
# this file only makes it double-clickable and keeps the window open so you
# can read the result.
#
cd "$(dirname "$0")"
./build-mac.sh
status=$?
echo
if [ $status -eq 0 ]; then
  echo "Done. You can close this window."
else
  echo "Build failed (exit code $status). See the messages above."
fi
read -p "Press Enter to close this window..." _
