#!/usr/bin/env bash
# 04 — two triggers with the same idempotencyKey during a burst return the
# same runId. Lua SETNX is the race-winner.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Idempotency collision in burst"

# Use a unique key per run so reruns don't collide with cached state.
KEY="challenge-idem-$(date +%s)-$RANDOM"
info "idempotencyKey=$KEY"

# Cold-gate burst — no pre-warm. The pre-gate claim
# (_plans/2026-05-21-mollifier-idempotency-claim.md) must serialise
# same-key triggers across BOTH the PG-passthrough and buffer-divert
# paths during the gate-transition window. All BURST_SIZE responses
# should converge on one runId regardless of where each landed.
burst_dir=$WORK/burst
mkdir -p "$burst_dir"
for i in $(seq 1 "$BURST_SIZE"); do
  curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" \
    -o "$burst_dir/$i.json" &
done
wait

# Collect unique runIds returned.
declare -a IDS=()
for f in "$burst_dir"/*.json; do
  id=$(jq -r '.id // empty' "$f")
  if [[ -n "$id" ]]; then
    IDS+=( "$id" )
  fi
done

# Dedup the IDs array
UNIQUE_IDS=$(printf "%s\n" "${IDS[@]}" | sort -u)
unique_count=$(echo "$UNIQUE_IDS" | wc -l | tr -d ' ')

info "captured ${#IDS[@]} responses, $unique_count unique runId(s)"
echo "$UNIQUE_IDS" | head -5 | while read -r id; do
  info "  $id"
done

if [[ "$unique_count" == "1" ]]; then
  pass "all $BURST_SIZE triggers returned the same runId — idempotency SETNX wins"
else
  fail "expected 1 unique runId, got $unique_count"
fi

# Count isCached:true responses — should be BURST_SIZE - 1 (only the winner
# is not cached).
cached_count=$(jq -s 'map(select(.isCached == true)) | length' "$burst_dir"/*.json)
not_cached_count=$(jq -s 'map(select(.isCached == false)) | length' "$burst_dir"/*.json)
info "isCached:true count = $cached_count, isCached:false = $not_cached_count"
if [[ "$not_cached_count" == "1" ]]; then
  pass "exactly one trigger has isCached:false (the SETNX winner)"
else
  fail "expected 1 isCached:false response, got $not_cached_count"
fi

# Triggering with the same key AFTER the burst should also hit cached.
header "Post-burst cached hit"
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"post\":true},\"options\":{\"idempotencyKey\":\"$KEY\"}}"
post_id=$(last_body | jq -r '.id')
post_cached=$(last_body | jq -r '.isCached')
if [[ "$post_id" == $(echo "$UNIQUE_IDS" | head -n 1) && "$post_cached" == "true" ]]; then
  pass "post-burst trigger returns the SETNX winner's runId with isCached:true"
else
  fail "post-burst id=$post_id cached=$post_cached (expected winner + cached)"
fi

summary
