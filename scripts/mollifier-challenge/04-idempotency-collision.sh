#!/usr/bin/env bash
# 04 — two triggers with the same idempotencyKey during a burst return the
# same runId. Lua SETNX is the race-winner.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Idempotency collision in burst"

# Use a unique key per run so reruns don't collide with cached state.
KEY="challenge-idem-$(date +%s)-$RANDOM"
info "idempotencyKey=$KEY"

# Pre-warm the gate FIRST. The Q5 design assumes the same-key burst all
# reaches the buffer — that's where SETNX is the race-winner. If the
# gate is still cold, the first 1-2 triggers go to PG and the buffer
# SETNX never sees them, producing two distinct race-winners (one PG,
# one buffer). That PG+buffer race exists architecturally but it's a
# separate concern from B6's buffer-side dedup, which is what this
# script exercises.
info "pre-warming the gate with $((BURST_SIZE / 2)) no-key triggers"
warm_dir=$WORK/warm
mkdir -p "$warm_dir"
for i in $(seq 1 $((BURST_SIZE / 2))); do
  curl -s -o "$warm_dir/$i.json" -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"warm\":$i}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" &
done
wait

# Fire BURST_SIZE same-key triggers simultaneously. The gate is now
# tripped, so all should mollify. SETNX serialises them — one wins, the
# rest receive duplicate_idempotency with the winner's runId
# (kind: duplicate_idempotency → isCached:true).
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
