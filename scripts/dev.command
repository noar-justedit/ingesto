#!/bin/bash
#
# Double-click launcher for dev.sh — runs syncto without building it.
#
# A .sh file is NOT double-clickable on a stock macOS: Finder opens it in a
# text editor. Only .command is bound to Terminal, which is why this wrapper
# exists alongside dev.sh rather than the README simply pointing at the .sh.
#
cd "$(dirname "$0")"

# The executable bit does not survive every way a folder can travel (a ZIP
# unpacked by some tools, a FAT/exFAT stick, a sync from Windows). Restore it
# rather than leaving the user with a bare "permission denied".
chmod +x ./*.sh ./*.command ../build.sh 2>/dev/null

bash ./dev.sh
status=$?
echo ""
read -p "Press Enter to close this window..."
exit $status
