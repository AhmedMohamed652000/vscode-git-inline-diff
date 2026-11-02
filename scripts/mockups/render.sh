#!/usr/bin/env bash
# Renders the README mock-ups: node gen.js -> html, then headless Chrome -> images/*.png (2x).
# Usage (Git Bash on Windows): bash scripts/mockups/render.sh
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
TMP="${TMPDIR:-/tmp}/hunkly-mockups"
mkdir -p "$TMP" "$ROOT/images"
node "$HERE/gen.js" "$TMP/html"
CHROME="${CHROME:-/c/Program Files/Google/Chrome/Application/chrome.exe}"
export MSYS_NO_PATHCONV=1
for spec in $(node -e 'for (const p of require(process.argv[1])) console.log(p.name+":"+p.w+":"+p.h)' "$TMP/html/pages.json"); do
  IFS=: read name w h <<< "$spec"
  # one profile dir per page: back-to-back runs on the same profile silently skip the screenshot
  "$CHROME" --headless=new --disable-gpu --hide-scrollbars --no-first-run --no-default-browser-check --disable-extensions \
    --user-data-dir="$TMP/profile-$name" --default-background-color=00000000 --force-device-scale-factor=2 \
    --window-size=$w,$h --screenshot="$TMP/$name.png" "file:///$TMP/html/$name.html" </dev/null >/dev/null 2>&1
  cp "$TMP/$name.png" "$ROOT/images/$name.png" && echo "images/$name.png"
done
