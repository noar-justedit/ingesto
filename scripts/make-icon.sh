#!/bin/bash
# -----------------------------------------------------------------------------
# syncto — regenerate the app icons from build-resources/icon.svg
#
#   ./scripts/make-icon.sh
#
# macOS only (uses sips + iconutil, both built in). Produces:
#   build-resources/icon.icns   macOS app icon
#   build-resources/icon.png    1024px master
#   build-resources/icons/*.png Linux icon set
#
# The .ico for Windows needs ImageMagick:  brew install imagemagick
# Ready-made icon.icns / icon.ico are already committed, so you only need this
# after editing the SVG.
# -----------------------------------------------------------------------------

set -e
cd "$(dirname "${BASH_SOURCE[0]}")/../build-resources"

SVG="icon.svg"
[ -f "$SVG" ] || { echo "icon.svg not found"; exit 1; }

echo "Rendering PNGs from $SVG…"
rm -rf .iconwork && mkdir -p .iconwork icons

# rsvg-convert first: it keeps the transparent background, which the icon needs.
# qlmanage is the no-dependency fallback but can flatten the alpha channel.
if command -v rsvg-convert &>/dev/null; then
  rsvg-convert -w 2048 -h 2048 -o icon.png "$SVG"
  sips -z 1024 1024 icon.png --out icon.png >/dev/null
else
  echo "rsvg-convert not found (brew install librsvg) — falling back to qlmanage."
  qlmanage -t -s 1024 -o .iconwork "$SVG" >/dev/null 2>&1
  MASTER=".iconwork/$(ls .iconwork | head -1)"
  [ -f "$MASTER" ] || { echo "Could not render the SVG. Install librsvg (brew install librsvg) and retry."; exit 1; }
  cp "$MASTER" icon.png
fi

for S in 16 32 48 64 128 256 512 1024; do
  sips -z $S $S icon.png --out "icons/${S}x${S}.png" >/dev/null
done

echo "Building icon.icns…"
rm -rf icon.iconset && mkdir icon.iconset
for S in 16 32 128 256 512; do
  sips -z $S $S icon.png --out "icon.iconset/icon_${S}x${S}.png" >/dev/null
  D=$((S * 2))
  sips -z $D $D icon.png --out "icon.iconset/icon_${S}x${S}@2x.png" >/dev/null
done
iconutil -c icns icon.iconset -o icon.icns
rm -rf icon.iconset .iconwork

if command -v magick &>/dev/null || command -v convert &>/dev/null; then
  echo "Building icon.ico…"
  CONV=$(command -v magick || command -v convert)
  "$CONV" icons/16x16.png icons/32x32.png icons/48x48.png icons/64x64.png \
          icons/128x128.png icons/256x256.png icon.ico
else
  echo "ImageMagick not found — keeping the existing icon.ico (brew install imagemagick to rebuild it)."
fi

echo "Done."
