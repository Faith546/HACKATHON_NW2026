#!/bin/zsh

CALL_SID="$1"

if [ -z "$CALL_SID" ]; then
  echo "❌ Falta CallSid."
  echo ""
  echo "Uso:"
  echo "./scripts/inspect-call.sh CA..."
  exit 1
fi

BASE="http://localhost:5050"

echo ""
echo "========================================"
echo " RELAY — CALL INSPECTOR"
echo "========================================"
echo ""
echo "CallSid:"
echo "$CALL_SID"

echo ""
echo "=== RECORDING ==="
curl -s "$BASE/api/calls/$CALL_SID/recording" | python3 -m json.tool

echo ""
echo "=== TIMING ==="
curl -s "$BASE/api/calls/$CALL_SID/timing" | python3 -m json.tool

echo ""
echo "=== EVIDENCE DEBUG ==="
curl -s "$BASE/api/calls/$CALL_SID/evidence-debug" | python3 -m json.tool

echo ""
echo "=== TRANSCRIPT ==="
curl -s "$BASE/api/calls/$CALL_SID/transcript" | python3 -m json.tool

echo ""
echo "========================================"
echo " FIN"
echo "========================================"
