#!/bin/zsh

ROOT="${0:A:h:h}"
SERVER="$ROOT/apps/server"
BASE_URL="${RELAY_LOCAL_BASE_URL:-http://localhost:5050}"
POLL_SECONDS="${RELAY_RECORDING_POLL_SECONDS:-2}"
TIMEOUT_SECONDS="${RELAY_RECORDING_TIMEOUT_SECONDS:-90}"
TEMP_DIR=$(mktemp -d /tmp/relay-inspect.XXXXXX)

trap 'rm -rf "$TEMP_DIR"' EXIT

if ! [[ "$POLL_SECONDS" =~ '^[1-9][0-9]*$' ]] ||
  ! [[ "$TIMEOUT_SECONDS" =~ '^[1-9][0-9]*$' ]]; then
  echo "❌ Polling y timeout deben ser enteros positivos."
  exit 1
fi

if ! command -v curl >/dev/null || ! command -v python3 >/dev/null; then
  echo "❌ Este script necesita curl y python3."
  exit 1
fi

json_value() {
  local json_path="$1"
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    if not isinstance(value, dict):
        value = None
        break
    value = value.get(part)
if value is None:
    print("")
elif isinstance(value, bool):
    print(str(value).lower())
elif isinstance(value, (dict, list)):
    print(json.dumps(value))
else:
    print(value)
' "$json_path"
}

json_count() {
  local json_path="$1"
  python3 -c '
import json, sys
value = json.load(sys.stdin)
for part in sys.argv[1].split("."):
    if not isinstance(value, dict):
        value = []
        break
    value = value.get(part, [])
print(len(value) if isinstance(value, list) else 0)
' "$json_path"
}

fetch_json() {
  curl -fsS --connect-timeout 3 --max-time 10 "$1" > "$2"
}

print_json() {
  local title="$1"
  local file="$2"
  echo ""
  echo "=== $title ==="
  python3 -m json.tool < "$file"
}

echo ""
echo "Buscando la llamada más reciente en $BASE_URL..."

if ! fetch_json "$BASE_URL/health" "$TEMP_DIR/health.json"; then
  echo "❌ Backend no disponible en $BASE_URL."
  exit 1
fi

if ! fetch_json "$BASE_URL/api/debug/calls/latest" "$TEMP_DIR/latest.json"; then
  echo "❌ No se encontró una llamada reciente en este proceso del backend."
  echo "   Recuerda que los stores son in-memory y se borran al reiniciar."
  exit 1
fi

CALL_SID=$(json_value "callId" < "$TEMP_DIR/latest.json")
STREAM_SID=$(json_value "streamSid" < "$TEMP_DIR/latest.json")

if [[ -z "$CALL_SID" ]]; then
  echo "❌ La respuesta latest no contiene CallSid."
  exit 1
fi

echo "CallSid detectado: $CALL_SID"
echo "Esperando recording completed (cada ${POLL_SECONDS}s, máximo ${TIMEOUT_SECONDS}s)..."

elapsed=0
RECORDING_SID=""
RECORDING_STATUS=""

while (( elapsed <= TIMEOUT_SECONDS )); do
  if fetch_json \
    "$BASE_URL/api/calls/$CALL_SID/recording" \
    "$TEMP_DIR/recording.json"; then
    RECORDING_SID=$(json_value "recording.recordingSid" < "$TEMP_DIR/recording.json")
    RECORDING_STATUS=$(json_value "recording.status" < "$TEMP_DIR/recording.json")
  fi

  if [[ "$RECORDING_STATUS" == "completed" || "$RECORDING_STATUS" == "absent" ]]; then
    break
  fi

  if (( elapsed >= TIMEOUT_SECONDS )); then
    break
  fi

  sleep "$POLL_SECONDS"
  (( elapsed += POLL_SECONDS ))
done

if [[ "$RECORDING_STATUS" != "completed" ]]; then
  echo "⚠️ Recording todavía no está completed después de ${elapsed}s."
fi

fetch_json "$BASE_URL/api/calls/$CALL_SID/recording" "$TEMP_DIR/recording.json" || echo '{}' > "$TEMP_DIR/recording.json"
fetch_json "$BASE_URL/api/calls/$CALL_SID/timing" "$TEMP_DIR/timing.json" || echo '{}' > "$TEMP_DIR/timing.json"
fetch_json "$BASE_URL/api/calls/$CALL_SID/evidence-debug" "$TEMP_DIR/evidence.json" || echo '{}' > "$TEMP_DIR/evidence.json"
fetch_json "$BASE_URL/api/calls/$CALL_SID/transcript" "$TEMP_DIR/transcript.json" || echo '{}' > "$TEMP_DIR/transcript.json"

RECORDING_SID=$(json_value "recording.recordingSid" < "$TEMP_DIR/recording.json")
RECORDING_STATUS=$(json_value "recording.status" < "$TEMP_DIR/recording.json")
TIMING_STREAM_SID=$(json_value "timing.stream.streamSid" < "$TEMP_DIR/timing.json")
[[ -n "$TIMING_STREAM_SID" ]] && STREAM_SID="$TIMING_STREAM_SID"
FIRST_MEDIA=$(json_value "timing.stream.firstMediaTimestampMs" < "$TEMP_DIR/timing.json")
LAST_MEDIA=$(json_value "timing.stream.lastMediaTimestampMs" < "$TEMP_DIR/timing.json")
SPEECH_RANGES=$(json_count "timing.callerSpeechRanges" < "$TEMP_DIR/timing.json")
TRANSCRIPT_TURNS=$(json_count "turns" < "$TEMP_DIR/transcript.json")
CORRELATION_STATUS=$(json_value "correlation.status" < "$TEMP_DIR/evidence.json")
CORRELATION_REASON=$(json_value "correlation.reason" < "$TEMP_DIR/evidence.json")

print_json "RECORDING" "$TEMP_DIR/recording.json"
print_json "TIMING" "$TEMP_DIR/timing.json"
print_json "EVIDENCE DEBUG" "$TEMP_DIR/evidence.json"
print_json "TRANSCRIPT" "$TEMP_DIR/transcript.json"

RECORDING_FILE=""
DOWNLOAD_OK=0
OPEN_WARNING=0

if [[ "$RECORDING_STATUS" == "completed" && -n "$RECORDING_SID" ]]; then
  if (cd "$SERVER" && npm run recording:download -- "$RECORDING_SID"); then
    RECORDING_FILE="$SERVER/.tmp/recordings/$RECORDING_SID.mp3"
    if [[ -f "$RECORDING_FILE" ]]; then
      DOWNLOAD_OK=1
      if ! open "$RECORDING_FILE" >/dev/null 2>&1; then
        OPEN_WARNING=1
      fi
    fi
  fi
fi

echo ""
echo "========================================"
echo " RELAY — LATEST CALL INSPECTION"
echo "========================================"
echo ""
echo "CallSid:"
echo "${CALL_SID:-not found}"
echo ""
echo "StreamSid:"
echo "${STREAM_SID:-not found}"
echo ""
echo "RecordingSid:"
echo "${RECORDING_SID:-not found}"
echo ""
echo "Recording status:"
echo "${RECORDING_STATUS:-not found}"
echo ""
echo "Transcript turns:"
echo "$TRANSCRIPT_TURNS"
echo ""
echo "Twilio stream range:"
echo "${FIRST_MEDIA:-unknown} ms → ${LAST_MEDIA:-unknown} ms"
echo ""
echo "Caller speech ranges:"
echo "$SPEECH_RANGES"
echo ""
echo "Correlation:"
echo "${CORRELATION_STATUS:-unknown}"
[[ -n "$CORRELATION_REASON" ]] && echo "$CORRELATION_REASON"
echo ""
echo "Recording:"
if [[ -n "$RECORDING_FILE" ]]; then
  echo "${RECORDING_FILE#$ROOT/}"
else
  echo "not downloaded"
fi

echo ""
echo "========================================"
echo " CHECKPOINT 4 OBSERVATION"
echo "========================================"
echo ""
echo "✅ Backend reachable"
echo "✅ Call found"
[[ -n "$STREAM_SID" ]] && echo "✅ Stream found" || echo "⚠️ Stream not found"
[[ -n "$RECORDING_SID" ]] && echo "✅ Recording found" || echo "⚠️ Recording not found"
[[ "$RECORDING_STATUS" == "completed" ]] && echo "✅ Recording completed" || echo "⚠️ Recording not completed"
[[ -n "$FIRST_MEDIA" && -n "$LAST_MEDIA" ]] && echo "✅ Timing data found" || echo "⚠️ Timing data incomplete"
(( TRANSCRIPT_TURNS > 0 )) && echo "✅ Transcript found" || echo "⚠️ Transcript not found"
(( DOWNLOAD_OK == 1 )) && echo "✅ MP3 downloaded" || echo "⚠️ MP3 not downloaded"
(( OPEN_WARNING == 1 )) && echo "⚠️ MP3 downloaded, but macOS open failed"

if [[ "$CORRELATION_STATUS" == "UNRESOLVED" ]]; then
  echo ""
  echo "⚠️ Recording correlation still UNRESOLVED"
  echo "until physical anchor is verified"
fi

echo ""
echo "TECHNICAL OBSERVATION READY"
echo "Checkpoint 4 PASS still requires listening to the MP3 and confirming"
echo "the ALFA/BETA phrases and timing belong to this call."
