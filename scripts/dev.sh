#!/bin/bash
#
# syncto — Folder comparison and synchronization
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

# syncto — Quick dev preview (no build needed). Double-clickable.

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if ! command -v node &>/dev/null; then
  echo "Node.js not found. Install it from https://nodejs.org"
  read -p "Press Enter to exit..."; exit 1
fi
if [ ! -d "node_modules" ]; then
  echo "First run — downloading dependencies…"
  npm install
fi
npm run dev
