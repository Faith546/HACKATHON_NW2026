#!/bin/zsh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"

osascript <<APPLESCRIPT
tell application "Terminal"
    activate

    do script "cd '$ROOT/apps/server' && clear && echo '=== RELAY SERVER ===' && npm run dev"

    delay 1

    do script "clear && echo '=== RELAY NGROK ===' && ngrok http 5050"

    delay 1

    do script "cd '$ROOT' && clear && echo '=== RELAY PREFLIGHT ===' && ./scripts/preflight.sh"
end tell
APPLESCRIPT
