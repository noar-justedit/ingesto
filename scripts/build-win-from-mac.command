#!/bin/bash
#
# Double-click launcher for build-win-from-mac.sh — run the Windows build from
# Finder instead of a terminal. The actual build logic lives in
# build-win-from-mac.sh; this file only keeps the window open afterwards.
#
cd "$(dirname "$0")"

# See build-mac.command: the executable bit does not survive every way a folder
# can travel, and "permission denied" tells the user nothing useful.
chmod +x ./*.sh ./*.command ../build.sh 2>/dev/null

bash ./build-win-from-mac.sh
status=$?
echo ""
read -p "Press Enter to close this window..."
exit $status
