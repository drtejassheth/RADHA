#!/bin/bash
# Double-click to open RADHA.
# Tries, in order: the installed app (/Applications or ~/Applications), the built app in this
# folder, then running from source. Reports a clear error if RADHA does not start.
cd "$(dirname "$0")" || exit 1

is_running() { pgrep -f "RADHA.app/Contents/MacOS/RADHA" >/dev/null || pgrep -f "$(pwd)/node_modules/electron/dist/Electron.app" >/dev/null; }

# A usable app bundle has its Electron framework (copies that drop symlinks do not).
usable() { [ -e "$1/Contents/Frameworks/Electron Framework.framework/Electron Framework" ]; }

fail() {
  echo "ERROR: $1"
  osascript -e "display alert \"RADHA could not open\" message \"$1\" as critical" >/dev/null 2>&1
  exit 1
}

if is_running; then
  osascript -e 'tell application "RADHA" to activate' >/dev/null 2>&1
  echo "RADHA is already open."
else
  launched=""
  for APP in "/Applications/RADHA.app" "$HOME/Applications/RADHA.app" "dist/mac-arm64/RADHA.app"; do
    if [ -d "$APP" ] && usable "$APP"; then
      open "$APP" && launched="$APP" && break
    fi
  done

  if [ -z "$launched" ]; then
    if [ -f "dist/RADHA-0.1.0-arm64.dmg" ]; then
      fail "The RADHA app is not installed. Open dist/RADHA-0.1.0-arm64.dmg and drag RADHA into Applications, then try again."
    fi
    command -v npm >/dev/null || fail "RADHA is not installed and Node.js is not available to run it from source."
    echo "Starting RADHA from source…"
    [ -d node_modules ] || npm install || fail "npm install failed."
    nohup npx electron . >/dev/null 2>&1 &
    disown
    launched="source"
  fi

  for _ in $(seq 1 20); do is_running && break; sleep 0.5; done
  is_running || fail "RADHA was started from $launched but exited immediately. Reinstall it from dist/RADHA-0.1.0-arm64.dmg."
  echo "RADHA opened ($launched)."
fi

# Close this Terminal window after a moment.
(sleep 1; osascript -e 'tell application "Terminal" to close (every window whose name contains "Open RADHA")' >/dev/null 2>&1) &
exit 0
