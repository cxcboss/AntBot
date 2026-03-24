#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_SOURCE_DIR="$ROOT_DIR/deploy/fnos-relay-app"
STAGE_DIR="$ROOT_DIR/.build/fnos-relay-app"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/release_fnos_app}"
ICON_SOURCE="$ROOT_DIR/icon.png"
FNPACK_BIN="$ROOT_DIR/.tools/fnpack"
FNPACK_URL="https://static2.fnnas.com/fnpack/fnpack-1.2.1-darwin-arm64"

if [ ! -f "$ICON_SOURCE" ]; then
  echo "[build-fnos-relay-app] icon not found: $ICON_SOURCE" >&2
  exit 1
fi

mkdir -p "$ROOT_DIR/.tools"
if [ ! -x "$FNPACK_BIN" ]; then
  echo "[build-fnos-relay-app] downloading fnpack..."
  curl -L "$FNPACK_URL" -o "$FNPACK_BIN"
  chmod +x "$FNPACK_BIN"
fi

rm -rf "$STAGE_DIR" "$OUTPUT_DIR"
mkdir -p "$STAGE_DIR" "$OUTPUT_DIR"

cp -R "$APP_SOURCE_DIR"/. "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/app/docker/remote" "$STAGE_DIR/app/ui/images" "$STAGE_DIR/wizard"
cp -R "$ROOT_DIR/src/remote"/. "$STAGE_DIR/app/docker/remote/"

sips -z 64 64 "$ICON_SOURCE" --out "$STAGE_DIR/ICON.PNG" >/dev/null
sips -z 256 256 "$ICON_SOURCE" --out "$STAGE_DIR/ICON_256.PNG" >/dev/null
cp "$STAGE_DIR/ICON.PNG" "$STAGE_DIR/app/ui/images/icon_64.png"
cp "$STAGE_DIR/ICON_256.PNG" "$STAGE_DIR/app/ui/images/icon_256.png"

chmod +x "$STAGE_DIR"/cmd/*

echo "[build-fnos-relay-app] building fpk..."
(cd "$STAGE_DIR" && "$FNPACK_BIN" build >/dev/null)

FPK_PATH="$(find "$STAGE_DIR" -maxdepth 1 -name '*.fpk' | head -n 1)"
if [ -z "$FPK_PATH" ]; then
  echo "[build-fnos-relay-app] build did not produce .fpk" >&2
  exit 1
fi

cp "$FPK_PATH" "$OUTPUT_DIR/"

echo "[build-fnos-relay-app] done"
echo "[build-fnos-relay-app] fpk: $OUTPUT_DIR/$(basename "$FPK_PATH")"
