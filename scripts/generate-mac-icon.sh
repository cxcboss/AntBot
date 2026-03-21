#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
SRC_ICON="$ROOT_DIR/icon.png"
if [[ ! -f "$SRC_ICON" ]]; then
  SRC_ICON="$ROOT_DIR/icons.png"
fi
ASSETS_DIR="$ROOT_DIR/assets"
WORK_ICON="$ASSETS_DIR/icon.png"
SQUARE_ICON="$ASSETS_DIR/icon-square.png"
ICONSET_DIR="$ASSETS_DIR/icon-build.iconset"
ICNS_PATH="$ASSETS_DIR/icon.icns"

if [[ ! -f "$SRC_ICON" ]]; then
  echo "missing source icon: $SRC_ICON" >&2
  exit 1
fi

mkdir -p "$ASSETS_DIR"
rm -rf "$ICONSET_DIR"
mkdir -p "$ICONSET_DIR"

cp "$SRC_ICON" "$WORK_ICON"
sips -p 1024 1024 "$WORK_ICON" --out "$SQUARE_ICON" >/dev/null

sips -z 16 16 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_16x16.png" >/dev/null
sips -z 32 32 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_16x16@2x.png" >/dev/null
sips -z 32 32 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_32x32.png" >/dev/null
sips -z 64 64 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_32x32@2x.png" >/dev/null
sips -z 128 128 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_128x128.png" >/dev/null
sips -z 256 256 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_128x128@2x.png" >/dev/null
sips -z 256 256 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_256x256.png" >/dev/null
sips -z 512 512 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_256x256@2x.png" >/dev/null
sips -z 512 512 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_512x512.png" >/dev/null
sips -z 1024 1024 "$SQUARE_ICON" --out "$ICONSET_DIR/icon_512x512@2x.png" >/dev/null

if iconutil -c icns "$ICONSET_DIR" -o "$ICNS_PATH"; then
  echo "generated: $ICNS_PATH"
else
  echo "warning: iconutil failed, fallback to existing icns if available." >&2
  if [[ -f "$ICNS_PATH" ]]; then
    echo "using existing: $ICNS_PATH"
  else
    echo "missing fallback icns: $ICNS_PATH" >&2
    exit 1
  fi
fi
