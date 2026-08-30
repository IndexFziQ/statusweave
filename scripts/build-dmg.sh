#!/bin/bash
# Build the unsigned StatusWeave floating-window companion DMG with one script.
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
VERSION="$(cd "$ROOT_DIR" && node -p "require('./package.json').version")"
APP_NAME="StatusWeave.app"
ASSET_NAME="StatusWeave-macOS-arm64.dmg"
DIST_DIR="$ROOT_DIR/dist"
STAGE_DIR="$(mktemp -d)"

cleanup() {
  /bin/rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

mkdir -p "$DIST_DIR"
STATUSWEAVE_VERSION="$VERSION" bash "$ROOT_DIR/float/build.sh"

cp -R "$ROOT_DIR/float/$APP_NAME" "$STAGE_DIR/$APP_NAME"
ln -s /Applications "$STAGE_DIR/Applications"
cp "$ROOT_DIR/LICENSE" "$STAGE_DIR/LICENSE.txt"

cat > "$STAGE_DIR/README.txt" <<EOF
FIRST: run this command in Terminal and keep it running:

    npx statusweave

StatusWeave.app is an unsigned beta floating-window companion for the local
StatusWeave dashboard at http://127.0.0.1:8787. It does not start the monitor
service by itself. Node.js 18 or newer is required for the command above.

Install:
1. Drag StatusWeave.app to Applications.
2. Run npx statusweave in Terminal.
3. Open StatusWeave.app.

If macOS blocks this unsigned beta, try opening it once, then go to System
Settings > Privacy & Security and choose Open Anyway. Download only from the
official StatusWeave GitHub release.

Version: $VERSION
Architecture: Apple silicon (arm64)
License: MIT
EOF

hdiutil create \
  -volname "StatusWeave $VERSION" \
  -srcfolder "$STAGE_DIR" \
  -format UDZO \
  -ov \
  "$DIST_DIR/$ASSET_NAME"

(cd "$DIST_DIR" && shasum -a 256 "$ASSET_NAME" > "$ASSET_NAME.sha256")

echo "✅ DMG: $DIST_DIR/$ASSET_NAME"
echo "✅ SHA256: $DIST_DIR/$ASSET_NAME.sha256"
