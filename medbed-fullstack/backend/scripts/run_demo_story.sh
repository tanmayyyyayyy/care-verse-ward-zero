#!/usr/bin/env bash
# scripts/run_demo_story.sh
# Runs the 3-minute scripted Care-Verse: Ward Zero demo story:
#   stable → slow decline → trend risk predicted → alert → no ACK → escalation → caregiver ACK → recovery
#
# Usage:
#   ./scripts/run_demo_story.sh           # Runs in real-time or fast mode (defaults to fast for testing)
#   ./scripts/run_demo_story.sh --full    # Runs standard 3-minute paced demo (180s)
#   ./scripts/run_demo_story.sh --speed 5 # 5x speed (36s)

set -e

BACKEND_URL="${BACKEND_URL:-http://localhost:5001}"
EMAIL="${DEMO_USER_EMAIL:-doctor@careverse.com}"
PASSWORD="${DEMO_USER_PASSWORD:-WardZero!2026}"
FAST_MODE="true"
SPEED="1"

while [[ "$#" -gt 0 ]]; do
  case $1 in
    --full|--standard) FAST_MODE="false"; shift ;;
    --fast) FAST_MODE="true"; shift ;;
    --speed) SPEED="$2"; FAST_MODE="false"; shift 2 ;;
    *) echo "Unknown parameter: $1"; exit 1 ;;
  esac
done

echo "🏥 Care-Verse: Ward Zero — Demo Story Runner"
echo "────────────────────────────────────────────"
echo "Authenticating as $EMAIL against $BACKEND_URL..."

LOGIN_RESP=$(curl -s -X POST "$BACKEND_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"email\":\"$EMAIL\",\"password\":\"$PASSWORD\"}")

TOKEN=$(echo "$LOGIN_RESP" | grep -o '"token":"[^"]*' | cut -d'"' -f4)

if [ -z "$TOKEN" ]; then
  echo "❌ Login failed. Response:"
  echo "$LOGIN_RESP"
  exit 1
fi

echo "✅ Authenticated. Token acquired."
echo "Triggering scripted demo story (fast: $FAST_MODE, speedMultiplier: $SPEED)..."
echo "Narrative: stable → slow decline → trend risk predicted → alert → no ACK → escalation → caregiver ACK → recovery"

curl -s -X POST "$BACKEND_URL/api/care/demo/story" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $TOKEN" \
  -d "{\"fast\":$FAST_MODE,\"speedMultiplier\":$SPEED}" | python3 -m json.tool || cat

echo ""
echo "✅ Demo story execution finished."
