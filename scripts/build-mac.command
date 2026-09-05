#!/bin/bash
#
# Double-click launcher for build-mac.sh — lets you run the Mac build from
# Finder instead of a terminal. The actual build logic lives in build-mac.sh;
# this file only makes it double-clickable and keeps the window open so you
# can read the result.
#
cd "$(dirname "$0")"

# Restore the executable bit on every script here before doing anything else.
# A ZIP unpacked by some tools, a copy through a FAT/exFAT stick, or a folder
# synchronised from Windows all drop it — and all the user sees is "permission
# denied", with no hint of what to do about it.
chmod +x ./*.sh ./*.command ../build.sh 2>/dev/null

# Called through `bash` rather than `./`, so this still works if the chmod above
# was refused (read-only volume, file owned by someone else).
bash ./build-mac.sh
status=$?
echo ""
read -p "Press Enter to close this window..."
exit $status
