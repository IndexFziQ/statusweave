#!/bin/bash
# 构建 StatusWeave 前置浮动窗口 (StatusWeave.app)
# 需要 Xcode Command Line Tools (xcode-select --install)
set -e
cd "$(dirname "$0")"

APP="StatusWeave.app"
VERSION="${STATUSWEAVE_VERSION:-0.1.0}"
TARGET="arm64-apple-macos12.0"
echo "🔨 编译 Swift..."
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"
swiftc -O -target "$TARGET" -o "$APP/Contents/MacOS/StatusWeave" StatusWeaveFloat.swift -framework Cocoa -framework WebKit

# 图标(源图 ../docs/logo/icon-1024.png,已预生成 float/AppIcon.icns;改了源图请重跑 iconutil)
if [ -f AppIcon.icns ]; then
  cp AppIcon.icns "$APP/Contents/Resources/AppIcon.icns"
fi

cat > "$APP/Contents/Info.plist" <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>CFBundleName</key><string>StatusWeave</string>
    <key>CFBundleDisplayName</key><string>StatusWeave</string>
    <key>CFBundleIdentifier</key><string>dev.statusweave.float</string>
    <key>CFBundleShortVersionString</key><string>STATUSWEAVE_VERSION</string>
    <key>CFBundleVersion</key><string>STATUSWEAVE_VERSION</string>
    <key>CFBundleExecutable</key><string>StatusWeave</string>
    <key>CFBundleIconFile</key><string>AppIcon</string>
    <key>CFBundlePackageType</key><string>APPL</string>
    <key>LSMinimumSystemVersion</key><string>12.0</string>
    <key>LSUIElement</key><true/>
    <key>NSPrincipalClass</key><string>NSApplication</string>
</dict>
</plist>
PLIST

/usr/bin/sed -i '' "s/STATUSWEAVE_VERSION/$VERSION/g" "$APP/Contents/Info.plist"

# Seal the complete app bundle with an ad-hoc signature. This verifies bundle
# integrity but is intentionally not Apple notarization.
codesign --force --sign - --timestamp=none "$APP"

MIN_OS="$(xcrun vtool -show-build "$APP/Contents/MacOS/StatusWeave" | awk '/minos/{print $2; exit}')"
if [ "$MIN_OS" != "12.0" ]; then
  echo "❌ Unexpected deployment target: $MIN_OS (expected 12.0)" >&2
  exit 1
fi
codesign --verify --deep --strict --verbose=2 "$APP"

echo "✅ 构建完成: float/$APP"
echo ""
echo "使用:"
echo "  1. 先启动服务:  node ../server.js   (或 statusweave)"
echo "  2. 打开浮动窗:  open $APP"
echo "  3. 菜单栏点 ⚡ 可显示/隐藏"
