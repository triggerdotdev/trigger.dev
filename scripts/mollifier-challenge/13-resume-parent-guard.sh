#!/usr/bin/env bash
# 13 — triggerAndWait with idempotencyKey matching a buffered run.
# B6b's `!resumeParentOnCompletion` guard skips the buffer-lookup branch
# (waitpoint blocking needs a PG row that doesn't exist for a buffered
# child). The triggerAndWait should produce a fresh PG run.
#
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "resumeParentOnCompletion + idempotencyKey skips buffer lookup"

# Step 1: produce a PG parent run (DELAYED) — we need a parent context
# for the triggerAndWait body.
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  '{"payload":{"role":"parent"},"options":{"delay":"10m"}}'
if ! last_status_ok; then
  fail "parent trigger failed: $(cat "$WORK/last.status")"
  summary
fi
PARENT_ID=$(last_body | jq -r '.id')
info "PG parent runId=$PARENT_ID"

# Step 2: burst children with a shared idempotency key → some mollified.
KEY="challenge-andwait-$(date +%s)-$RANDOM"
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

BUFFERED_ID=""
for f in "$BURST_DIR"/*.json; do
  if jq -e '.notice.code == "mollifier.queued"' "$f" >/dev/null 2>&1; then
    BUFFERED_ID=$(jq -r '.id' "$f")
    break
  fi
done
if [[ -z "$BUFFERED_ID" ]]; then
  fail "no buffered child — gate not tripping"
  summary
fi
pass "buffered runId=$BUFFERED_ID has idempotencyKey=$KEY"

# Step 3: triggerAndWait with the same key. parentRunId +
# resumeParentOnCompletion:true. Per F4 in mollifierGate, this bypasses
# the mollifier gate entirely; per B6b, the IdempotencyKeyConcern's
# buffer lookup is skipped for this case.
#
# Expected: fresh PG run (NOT cached to the buffered one).
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"andwait\":true},\"options\":{\"idempotencyKey\":\"$KEY\",\"parentRunId\":\"$PARENT_ID\",\"resumeParentOnCompletion\":true}}"
if ! last_status_ok; then
  fail "triggerAndWait status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
ANDWAIT_ID=$(last_body | jq -r '.id')
ANDWAIT_CACHED=$(last_body | jq -r '.isCached')

if [[ "$ANDWAIT_ID" == "$BUFFERED_ID" ]]; then
  fail "triggerAndWait returned the buffered runId — guard not skipping the lookup"
elif [[ "$ANDWAIT_CACHED" == "true" ]]; then
  fail "triggerAndWait returned isCached:true (id=$ANDWAIT_ID) — expected fresh"
else
  pass "triggerAndWait produced fresh runId=$ANDWAIT_ID (guard skipped buffer)"
fi

# Spot-check: the fresh triggerAndWait should be PG-canonical (F4 bypass).
api GET "/api/v3/runs/$ANDWAIT_ID"
if last_status_ok; then
  pass "fresh triggerAndWait run resolvable"
else
  fail "triggerAndWait run $(cat "$WORK/last.status")"
fi

summary
