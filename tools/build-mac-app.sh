#!/bin/bash
# Build Serigraph.app, the native Mac window for the local Serigraph server.
#
#   tools/build-mac-app.sh [destination.app]
#
# The default destination is ~/Applications/Serigraph.app. The app talks to
# the background server that `serigraph install` sets up; it does not contain
# the engine. Needs the Swift compiler from Xcode or the Command Line Tools
# (install them with: xcode-select --install).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="${1:-$HOME/Applications/Serigraph.app}"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/serigraph-mac.XXXXXX")"
trap 'rm -r "$WORK"' EXIT

command -v swiftc >/dev/null || { echo "Swift is missing. Run: xcode-select --install" >&2; exit 1; }
VERSION="$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo dev)"
SOURCE_HASH="$(cat "$ROOT/mac/Serigraph.swift" "$ROOT/mac/make-icon.swift" "$0" | shasum -a 256 | cut -c1-16)"

BUNDLE="$WORK/Serigraph.app"
mkdir -p "$BUNDLE/Contents/MacOS" "$BUNDLE/Contents/Resources"
swiftc -O -o "$BUNDLE/Contents/MacOS/Serigraph" "$ROOT/mac/Serigraph.swift"
swiftc -O -o "$WORK/make-icon" "$ROOT/mac/make-icon.swift"
"$WORK/make-icon" "$WORK/AppIcon.iconset"
iconutil -c icns -o "$BUNDLE/Contents/Resources/AppIcon.icns" "$WORK/AppIcon.iconset"

cat > "$BUNDLE/Contents/Info.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Serigraph</string>
  <key>CFBundleDisplayName</key><string>Serigraph</string>
  <key>CFBundleIdentifier</key><string>app.serigraph.mac</string>
  <key>CFBundleExecutable</key><string>Serigraph</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>2.0</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>SerigraphSourceHash</key><string>$SOURCE_HASH</string>
  <key>LSMinimumSystemVersion</key><string>13.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.productivity</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSSupportsAutomaticTermination</key><false/>
  <key>CFBundleDocumentTypes</key>
  <array>
    <dict>
      <key>CFBundleTypeName</key><string>Serigraph map</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.yaml</string></array>
    </dict>
    <dict>
      <key>CFBundleTypeName</key><string>Folder of Serigraph maps</string>
      <key>CFBundleTypeRole</key><string>Editor</string>
      <key>LSHandlerRank</key><string>Alternate</string>
      <key>LSItemContentTypes</key><array><string>public.folder</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

codesign --force --sign - "$BUNDLE" >/dev/null 2>&1
mkdir -p "$(dirname "$APP")"
if [ -d "$APP" ]; then mv "$APP" "$WORK/previous.app"; fi
mv "$BUNDLE" "$APP"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1 || true
echo "Built $APP"
