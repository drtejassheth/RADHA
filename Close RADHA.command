#!/bin/bash
# Double-click to close RADHA (installed app, built app, or the source/dev version).
cd "$(dirname "$0")" || exit 1

osascript -e 'if application "RADHA" is running then tell application "RADHA" to quit' >/dev/null 2>&1
# Development copy runs inside Electron from this folder.
pkill -f "$(pwd)/node_modules/electron/dist/Electron.app" >/dev/null 2>&1
sleep 1
if pgrep -f "RADHA.app/Contents/MacOS/RADHA" >/dev/null; then
  pkill -f "RADHA.app/Contents/MacOS/RADHA"
fi
echo "RADHA closed."
(sleep 1; osascript -e 'tell application "Terminal" to close (every window whose name contains "Close RADHA")' >/dev/null 2>&1) &
exit 0
