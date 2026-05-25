#!/usr/bin/env bash
set -euo pipefail

# Load env vars (expects they are exported in the container)
: "${WAHA_URL:?WAHA_URL not set}"
: "${WAHA_API_KEY:?WAHA_API_KEY not set}"
: "${WHATSAPP_HOOK_URL:?WHATSAPP_HOOK_URL not set}"
: "${WHATSAPP_HOOK_EVENTS:?WHATSAPP_HOOK_EVENTS not set}"

SESSION_NAME="default"

# Helper to GET session
get_session() {
  curl -s -H "Content-Type: application/json" -H "X-Api-Key: $WAHA_API_KEY" "$WAHA_URL/api/sessions/$SESSION_NAME"
}

# Check if session exists and is WORKING
session_info=$(get_session)
status=$(echo "$session_info" | grep -o "\"status\":\"[^"]*\"")
if [[ "$status" == *"WORKING"* ]]; then
  echo "✅ WAHA session '$SESSION_NAME' already WORKING"
else
  echo "⚠️ Session missing or not WORKING. Creating..."
  # Create session with webhook config (POST /api/sessions)
  create_payload=$(cat <<EOF
{
  "name": "$SESSION_NAME",
  "config": {
    "webhook": {
      "url": "$WHATSAPP_HOOK_URL",
      "events": ["$WHATSAPP_HOOK_EVENTS"]
    }
  }
}
EOF
)
  curl -s -X POST -H "Content-Type: application/json" -H "X-Api-Key: $WAHA_API_KEY" -d "$create_payload" "$WAHA_URL/api/sessions"
fi

# Ensure webhook config is present (PUT to session)
put_payload=$(cat <<EOF
{"config":{"webhook":{"url":"$WHATSAPP_HOOK_URL","events":["$WHATSAPP_HOOK_EVENTS"]}}}
EOF
)
curl -s -X PUT -H "Content-Type: application/json" -H "X-Api-Key: $WAHA_API_KEY" -d "$put_payload" "$WAHA_URL/api/sessions/$SESSION_NAME"

echo "✅ Webhook config ensured for session '$SESSION_NAME'"

# Poll until session is WORKING and QR is not needed
while true; do
  info=$(get_session)
  echo "$info" | grep -q "\"status\":\"WORKING\"" && break
  echo "⏳ Waiting for WAHA session to become WORKING..."
  sleep 5
done

echo "🚀 WAHA session is ready and WORKING"
