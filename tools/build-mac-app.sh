#!/bin/bash
# Build dist/Serigraph.app — a double-clickable launcher for the local
# Serigraph server. Zero dependencies: the bundle is a plain .app folder
# whose script starts `node server/main.js` from this repo and opens the
# app in the default browser. The repo path is baked in at build time.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP="$ROOT/dist/Serigraph.app"

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$APP/Contents/Resources"

cat > "$APP/Contents/Info.plist" << 'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Serigraph</string>
  <key>CFBundleDisplayName</key><string>Serigraph</string>
  <key>CFBundleIdentifier</key><string>app.serigraph.local</string>
  <key>CFBundleVersion</key><string>1.0.0</string>
  <key>CFBundleShortVersionString</key><string>1.0.0</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>Serigraph</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>LSUIElement</key><true/>
</dict>
</plist>
PLIST

cat > "$APP/Contents/MacOS/Serigraph" << LAUNCHER
#!/bin/bash
# Serigraph launcher — starts the local server if needed, then opens the app.
URL="http://localhost:4700/"
ROOT="$ROOT"

if ! curl -s -m 2 -o /dev/null "\$URL"; then
  cd "\$ROOT"
  nohup /usr/bin/env node server/main.js >/dev/null 2>&1 &
  for _ in \$(seq 1 40); do
    curl -s -m 1 -o /dev/null "\$URL" && break
    sleep 0.25
  done
fi
open "\$URL"
LAUNCHER
chmod +x "$APP/Contents/MacOS/Serigraph"

echo "Built $APP"
echo "Move it to /Applications or your Dock. Double-click starts the server and opens http://localhost:4700/."
