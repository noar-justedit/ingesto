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

# Convert ingesto.svg → icon.icns using only native macOS tools (no brew needed)

SCRIPT_DIR="$( cd "$( dirname "${BASH_SOURCE[0]}" )" && pwd )"
PROJECT_DIR="$SCRIPT_DIR/.."
SVG="$PROJECT_DIR/build-resources/icon_source.svg"
ICONSET="$PROJECT_DIR/build-resources/icon.iconset"
ICNS="$PROJECT_DIR/build-resources/icon.icns"
TMP_PNG="/tmp/ingesto_icon_1024.png"

if [ ! -f "$SVG" ]; then
  echo "❌ SVG source not found: $SVG"
  exit 1
fi

echo "🎨 Converting SVG → .icns (native macOS tools only)…"
mkdir -p "$ICONSET"

# ── Strategy 1: Python + Quartz (always available on macOS) ──────────────────
python3 - "$SVG" "$TMP_PNG" << 'PYEOF'
import sys, subprocess, os

svg_path = sys.argv[1]
out_path  = sys.argv[2]

# Use NSImage via PyObjC if available
try:
    from AppKit import NSImage, NSBitmapImageRep, NSPNGFileType, NSGraphicsContext, NSRect, NSZeroRect
    from Foundation import NSData
    img = NSImage.alloc().initWithContentsOfFile_(svg_path)
    if img:
        size = 1024
        rep = NSBitmapImageRep.alloc().initWithBitmapDataPlanes_pixelsWide_pixelsHigh_bitsPerSample_samplesPerPixel_hasAlpha_isPlanar_colorSpaceName_bytesPerRow_bitsPerPixel_(
            None, size, size, 8, 4, True, False, 'NSCalibratedRGBColorSpace', 0, 0)
        NSGraphicsContext.saveGraphicsState()
        ctx = NSGraphicsContext.graphicsContextWithBitmapImageRep_(rep)
        NSGraphicsContext.setCurrentContext_(ctx)
        img.drawInRect_(((0,0),(size,size)))
        NSGraphicsContext.restoreGraphicsState()
        data = rep.representationUsingType_properties_(NSPNGFileType, None)
        data.writeToFile_atomically_(out_path, True)
        print("pyobjc OK")
        sys.exit(0)
except Exception as e:
    print(f"pyobjc failed: {e}")

# Fallback: use qlmanage to render the SVG, then sips to resize
tmp_dir = "/tmp/ingesto_ql_render"
os.makedirs(tmp_dir, exist_ok=True)
r = subprocess.run(
    ["qlmanage", "-t", "-s", "1024", "-o", tmp_dir, svg_path],
    capture_output=True, timeout=10
)
# qlmanage outputs: <filename>.png
import glob
pngs = glob.glob(tmp_dir + "/*.png")
if pngs:
    import shutil
    shutil.copy(pngs[0], out_path)
    print("qlmanage OK")
    sys.exit(0)

print("all strategies failed")
sys.exit(1)
PYEOF

# ── Strategy 2: qlmanage directly in bash ────────────────────────────────────
if [ ! -f "$TMP_PNG" ]; then
  echo "  Trying qlmanage…"
  QLDIR="/tmp/ingesto_ql_$$"
  mkdir -p "$QLDIR"
  qlmanage -t -s 1024 -o "$QLDIR" "$SVG" 2>/dev/null
  QL_OUT=$(ls "$QLDIR"/*.png 2>/dev/null | head -1)
  if [ -n "$QL_OUT" ]; then
    cp "$QL_OUT" "$TMP_PNG"
    rm -rf "$QLDIR"
    echo "  qlmanage: OK"
  fi
fi

# ── Strategy 3: Safari/WebKit via AppleScript ─────────────────────────────────
if [ ! -f "$TMP_PNG" ]; then
  echo "  Trying WebKit via AppleScript…"
  osascript << ASEOF 2>/dev/null
    set svgPath to POSIX file "$SVG"
    set outPath to "$TMP_PNG"
    tell application "Safari"
      set doc to open svgPath
      delay 1
      do JavaScript "
        var canvas = document.createElement('canvas');
        canvas.width = 1024; canvas.height = 1024;
        var ctx = canvas.getContext('2d');
        var img = document.querySelector('svg');
        var xml = new XMLSerializer().serializeToString(img);
        var blob = new Blob([xml], {type:'image/svg+xml'});
        var url = URL.createObjectURL(blob);
        var i = new Image();
        i.onload = function() { ctx.drawImage(i,0,0,1024,1024); };
        i.src = url;
      " in doc
      close doc saving no
    end tell
ASEOF
fi

# ── Strategy 4: Python PIL/Pillow (if installed) ──────────────────────────────
if [ ! -f "$TMP_PNG" ]; then
  echo "  Trying Pillow…"
  python3 -c "
from PIL import Image
import cairosvg
cairosvg.svg2png(url='$SVG', write_to='$TMP_PNG', output_width=1024, output_height=1024)
" 2>/dev/null && echo "  Pillow+cairosvg: OK"
fi

# ── Check if we got a PNG ─────────────────────────────────────────────────────
if [ ! -f "$TMP_PNG" ]; then
  echo ""
  echo "  ⚠️  Could not render SVG automatically."
  echo "  Running quick fix: converting SVG to PNG via sips..."
  # sips can read SVGs on recent macOS (Ventura+)
  sips -s format png -z 1024 1024 "$SVG" --out "$TMP_PNG" 2>/dev/null
fi

if [ ! -f "$TMP_PNG" ]; then
  echo "❌ Could not generate PNG from SVG."
  echo "   Please run once: brew install librsvg"
  echo "   Then re-run this script."
  exit 1
fi

# ── Generate iconset from 1024px PNG ──────────────────────────────────────────
echo "  Generating icon sizes from PNG…"
declare -a SIZES=(16 32 64 128 256 512 1024)
for SIZE in "${SIZES[@]}"; do
  sips -s format png -z $SIZE $SIZE "$TMP_PNG" \
    --out "$ICONSET/icon_${SIZE}x${SIZE}.png" 2>/dev/null
done
# @2x variants
sips -s format png -z  32  32 "$TMP_PNG" --out "$ICONSET/icon_16x16@2x.png"   2>/dev/null
sips -s format png -z  64  64 "$TMP_PNG" --out "$ICONSET/icon_32x32@2x.png"   2>/dev/null
sips -s format png -z 256 256 "$TMP_PNG" --out "$ICONSET/icon_128x128@2x.png" 2>/dev/null
sips -s format png -z 512 512 "$TMP_PNG" --out "$ICONSET/icon_256x256@2x.png" 2>/dev/null
sips -s format png -z 1024 1024 "$TMP_PNG" --out "$ICONSET/icon_512x512@2x.png" 2>/dev/null

# ── Build .icns ────────────────────────────────────────────────────────────────
iconutil -c icns "$ICONSET" -o "$ICNS" 2>/dev/null
STATUS=$?

# Cleanup
rm -rf "$ICONSET" "$TMP_PNG"

if [ $STATUS -eq 0 ] && [ -f "$ICNS" ]; then
  echo "✅ icon.icns created successfully"
else
  echo "⚠️  iconutil failed — the app will use a default icon"
fi
