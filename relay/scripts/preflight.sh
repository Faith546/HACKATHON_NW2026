#!/bin/zsh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
SERVER="$ROOT/apps/server"

echo "Esperando backend y ngrok..."
sleep 5

NGROK_URL=$(curl -s http://127.0.0.1:4040/api/tunnels 2>/dev/null | \
python3 -c 'import sys,json; d=json.load(sys.stdin); print(next(t["public_url"] for t in d["tunnels"] if t["proto"]=="https"))' 2>/dev/null)

echo ""
echo "=============================="
echo " RELAY PREFLIGHT"
echo "=============================="

echo ""
echo "NGROK:"
echo "$NGROK_URL"

cd "$SERVER"

CONFIG_URL=$(grep '^PUBLIC_BASE_URL=' .env | cut -d= -f2-)
VOICE_MODE=$(grep '^VOICE_MODE=' .env | cut -d= -f2-)
MODEL=$(grep '^REALTIME_MODEL=' .env | cut -d= -f2-)
VOICE=$(grep '^REALTIME_VOICE=' .env | cut -d= -f2-)

echo ""
echo "CONFIG:"
echo "VOICE_MODE=$VOICE_MODE"
echo "REALTIME_MODEL=$MODEL"
echo "REALTIME_VOICE=${VOICE:-ash (default)}"
echo "PUBLIC_BASE_URL=$CONFIG_URL"

echo ""

if [ "$NGROK_URL" != "$CONFIG_URL" ]; then
  echo "❌ PUBLIC_BASE_URL NO coincide con ngrok."
  echo ""
  echo "ngrok: $NGROK_URL"
  echo ".env:   $CONFIG_URL"
  echo ""
  echo "NO HAGAS LLAMADAS todavía."
else
  echo "✅ PUBLIC_BASE_URL coincide."
fi

echo ""
echo "HEALTH:"

HEALTH=$(curl -s "$NGROK_URL/health" 2>/dev/null)
echo "$HEALTH"

echo ""

if [[ "$HEALTH" == *'"ok":true'* ]] && [ "$NGROK_URL" = "$CONFIG_URL" ]; then
  echo "================================"
  echo " ✅ RELAY READY FOR CALLS"
  echo "================================"
else
  echo "================================"
  echo " ❌ RELAY NOT READY"
  echo "================================"
fi

echo ""
echo "Esta terminal queda abierta para pruebas."
exec zsh
