#!/usr/bin/env python3
"""
syncto - regenerate every icon asset from build-resources/icon.svg.

Cross-platform fallback for scripts/make-icon.sh (which is macOS-only).
Needs:  pip install cairosvg pillow
"""
import io
import os
import struct
import sys

import cairosvg
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, "..", "build-resources")
SVG = os.path.join(RES, "icon.svg")
SUPERSAMPLE = 2048

os.makedirs(os.path.join(RES, "icons"), exist_ok=True)

master_bytes = cairosvg.svg2png(url=SVG, output_width=SUPERSAMPLE, output_height=SUPERSAMPLE)
master = Image.open(io.BytesIO(master_bytes)).convert("RGBA")


def at(size):
    return master.resize((size, size), Image.LANCZOS)


# --- 1024 master + Linux icon set -------------------------------------------
at(1024).save(os.path.join(RES, "icon.png"))
for s in (16, 32, 48, 64, 128, 256, 512, 1024):
    at(s).save(os.path.join(RES, "icons", f"{s}x{s}.png"))
print("PNG set written")

# --- Windows .ico ------------------------------------------------------------
at(256).save(
    os.path.join(RES, "icon.ico"),
    format="ICO",
    sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
)
print("icon.ico written")

# --- macOS .icns -------------------------------------------------------------
# Same PNG-based layout that `iconutil -c icns` produces.
ICNS_TYPES = [
    (b"icp4", 16),
    (b"icp5", 32),
    (b"ic07", 128),
    (b"ic08", 256),
    (b"ic09", 512),
    (b"ic10", 1024),
    (b"ic11", 32),    # 16pt @2x
    (b"ic12", 64),    # 32pt @2x
    (b"ic13", 256),   # 128pt @2x
    (b"ic14", 512),   # 256pt @2x
]

chunks = []
for tag, size in ICNS_TYPES:
    buf = io.BytesIO()
    at(size).save(buf, format="PNG")
    data = buf.getvalue()
    chunks.append(tag + struct.pack(">I", len(data) + 8) + data)

body = b"".join(chunks)
icns = b"icns" + struct.pack(">I", len(body) + 8) + body
with open(os.path.join(RES, "icon.icns"), "wb") as f:
    f.write(icns)
print(f"icon.icns written ({len(icns)} bytes, {len(ICNS_TYPES)} representations)")
