#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
FLUTTER_DIR="$ROOT_DIR/clients/antbot_flutter"
OUTPUT_DIR="${OUTPUT_DIR:-$ROOT_DIR/release_flutter_figma}"
PUB_HOSTED_URL="${PUB_HOSTED_URL:-https://pub.flutter-io.cn}"
FLUTTER_STORAGE_BASE_URL="${FLUTTER_STORAGE_BASE_URL:-https://storage.flutter-io.cn}"
FLUTTER_ENV=("PUB_HOSTED_URL=$PUB_HOSTED_URL" "FLUTTER_STORAGE_BASE_URL=$FLUTTER_STORAGE_BASE_URL")

cd "$ROOT_DIR"

if [ "${SKIP_BACKEND_BUILD:-0}" = "1" ]; then
  echo "[build-flutter-mac] skipping Electron backend build"
else
  echo "[build-flutter-mac] building packaged Electron backend..."
  npm run build:mac
fi

echo "[build-flutter-mac] resolving Flutter packages..."
cd "$FLUTTER_DIR"
xattr -cr "$FLUTTER_DIR/assets" "$FLUTTER_DIR/macos"
env "${FLUTTER_ENV[@]}" flutter pub get

echo "[build-flutter-mac] building Flutter macOS app..."
env "${FLUTTER_ENV[@]}" flutter build macos --release --config-only
cd "$FLUTTER_DIR/macos"
xcodebuild \
  -workspace Runner.xcworkspace \
  -scheme Runner \
  -configuration Release \
  -derivedDataPath ../build/macos \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  build >/dev/null
cd "$FLUTTER_DIR"

VERSION="$(awk '/^version:/{print $2}' "$FLUTTER_DIR/pubspec.yaml" | cut -d+ -f1)"
APP_PATH="$FLUTTER_DIR/build/macos/Build/Products/Release/搬运蚁 Flutter.app"
BACKEND_APP="$ROOT_DIR/release/mac-arm64/搬运蚁.app"

if [ ! -d "$APP_PATH" ]; then
  echo "[build-flutter-mac] flutter app bundle not found: $APP_PATH" >&2
  exit 1
fi

if [ ! -d "$BACKEND_APP" ]; then
  echo "[build-flutter-mac] backend app bundle not found: $BACKEND_APP" >&2
  exit 1
fi

echo "[build-flutter-mac] embedding backend app..."
rm -rf "$APP_PATH/Contents/Resources/backend"
mkdir -p "$APP_PATH/Contents/Resources/backend"
cp -R "$BACKEND_APP" "$APP_PATH/Contents/Resources/backend/"

echo "[build-flutter-mac] preparing separate output directory..."
rm -rf "$OUTPUT_DIR"
mkdir -p "$OUTPUT_DIR"
cp -R "$APP_PATH" "$OUTPUT_DIR/"

ZIP_PATH="$OUTPUT_DIR/搬运蚁-Flutter-$VERSION-mac-arm64.zip"
DMG_ROOT="$OUTPUT_DIR/dmg-root"
DMG_PATH="$OUTPUT_DIR/搬运蚁-Flutter-$VERSION-mac-arm64.dmg"

echo "[build-flutter-mac] creating zip artifact..."
ditto -c -k --sequesterRsrc --keepParent \
  "$OUTPUT_DIR/搬运蚁 Flutter.app" \
  "$ZIP_PATH"

echo "[build-flutter-mac] creating dmg artifact..."
rm -rf "$DMG_ROOT"
mkdir -p "$DMG_ROOT"
cp -R "$OUTPUT_DIR/搬运蚁 Flutter.app" "$DMG_ROOT/"
ln -s /Applications "$DMG_ROOT/Applications"
hdiutil create \
  -volname "搬运蚁 Flutter" \
  -srcfolder "$DMG_ROOT" \
  -ov \
  -format UDZO \
  "$DMG_PATH" >/dev/null
rm -rf "$DMG_ROOT"

echo "[build-flutter-mac] done"
echo "[build-flutter-mac] app: $OUTPUT_DIR/搬运蚁 Flutter.app"
echo "[build-flutter-mac] zip: $ZIP_PATH"
echo "[build-flutter-mac] dmg: $DMG_PATH"
