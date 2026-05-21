#!/usr/bin/env bash
# 10 — idempotency-key reset endpoint clears the key in both stores.
# Verifies B6 reset-side correctness end-to-end:
#   1. Trigger with key X → mollifies, SETNX in buffer.
#   2. POST /api/v1/idempotencyKeys/{X}/reset → clears PG (no row) + buffer
#      lookup (resetIdempotency Lua DELs the lookup, nulls snapshot fields).
#   3. Re-trigger with key X → must produce a NEW runId, isCached:false.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Idempotency-key reset on a buffered run"

KEY="challenge-reset-$(date +%s)-$RANDOM"
info "idempotencyKey=$KEY"

# Step 1: produce a buffered run with key X.
BURST_DIR=$WORK/burst
mkdir -p "$BURST_DIR"
for i in $(seq 1 "$BURST_SIZE"); do
  curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" \
    -o "$BURST_DIR/$i.json" &
done
wait

FIRST_ID=""
for f in "$BURST_DIR"/*.json; do
  if jq -e '.notice.code == "mollifier.queued"' "$f" >/dev/null 2>&1; then
    FIRST_ID=$(jq -r '.id' "$f")
    break
  fi
done

if [[ -z "$FIRST_ID" ]]; then
  fail "no mollified response in burst — gate not tripping"
  summary
fi
pass "buffered run created with key=$KEY (runId=$FIRST_ID)"

# Step 2: hit the reset endpoint. The SDK path is
# `POST /api/v1/idempotencyKeys/{key}/reset` but it expects the task id
# in the body. Confirm exact route signature against current api routes.
api POST "/api/v1/idempotencyKeys/$KEY/reset" "{\"taskIdentifier\":\"$TASK_ID\"}"
status=$(cat "$WORK/last.status")
if [[ "$status" =~ ^2 ]]; then
  pass "reset endpoint returned 2xx"
else
  fail "reset returned $status, body=$(last_body | head -c 200)"
  summary
fi

# Step 3: trigger again with the same key. Should produce a NEW runId.
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"post\":\"reset\"},\"options\":{\"idempotencyKey\":\"$KEY\"}}"
if ! last_status_ok; then
  fail "post-reset trigger status=$(cat "$WORK/last.status")"
  summary
fi
NEW_ID=$(last_body | jq -r '.id')
NEW_CACHED=$(last_body | jq -r '.isCached')

if [[ "$NEW_ID" == "$FIRST_ID" ]]; then
  fail "post-reset trigger returned the SAME runId $FIRST_ID — reset didn't clear the lookup"
elif [[ "$NEW_CACHED" == "true" ]]; then
  fail "post-reset trigger returned isCached:true (new id $NEW_ID) — should be false"
else
  pass "post-reset trigger created NEW runId=$NEW_ID, isCached:false"
fi

summary
