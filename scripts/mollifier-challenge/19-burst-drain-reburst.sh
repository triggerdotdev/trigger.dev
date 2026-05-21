#!/usr/bin/env bash
# 19 — burst → drain → re-burst with the same idempotency key.
# Verifies the new claim system doesn't *break* the existing
# post-materialisation cached-hit path: once the buffered (or PG) winner
# of the first burst is materialised into PG, the second burst's
# triggers should resolve via IdempotencyKeyConcern's PG-findFirst
# (existing behaviour), bypassing the claim entirely.
#
# Required: drainer ON.

source "$(dirname "$0")/00-lib.sh"

header "Burst → drain → re-burst (cross-store cached resolve)"

KEY="challenge-reburst-$(date +%s)-$RANDOM"
info "shared idempotencyKey=$KEY"

# Burst 1 — cold gate, same-key triggers serialise through the claim.
info "burst 1 — 20 same-key triggers"
B1=$WORK/burst1
mkdir -p "$B1"
for i in $(seq 1 20); do
  curl -s -o "$B1/$i.json" -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" &
done
wait

declare -a IDS1=()
for f in "$B1"/*.json; do
  id=$(jq -r '.id // empty' "$f")
  if [[ -n "$id" ]]; then IDS1+=( "$id" ); fi
done
U1=$(printf "%s\n" "${IDS1[@]}" | sort -u)
n1=$(echo "$U1" | wc -l | tr -d ' ')
info "burst 1: ${#IDS1[@]} responses, $n1 unique runId(s)"
if [[ "$n1" == "1" ]]; then
  pass "burst 1 converged on one runId via the claim"
  WINNER=$(echo "$U1" | head -1)
  info "winner runId: $WINNER"
else
  fail "burst 1 produced $n1 unique runIds — claim path broken"
  summary
fi

# Wait for the winner to materialise into PG (drainer must be ON).
info "polling for materialisation (drainer must be ON)"
deadline=$(($(date +%s) + 60))
materialised=""
while (( $(date +%s) < deadline )); do
  api GET "/api/v3/runs/$WINNER" >/dev/null
  if last_body | jq -e '.attempts // [] | length > 0' >/dev/null 2>&1; then
    materialised="yes"
    break
  fi
  status=$(last_body | jq -r '.status // empty')
  if [[ "$status" != "" && "$status" != "PENDING" && "$status" != "QUEUED" && "$status" != "DELAYED" ]]; then
    materialised="yes"
    break
  fi
  sleep 1
done
if [[ -z "$materialised" ]]; then
  fail "winner did not materialise within 60s — drainer not on?"
  summary
fi
pass "winner $WINNER materialised into PG"

# Burst 2 — same key. Should ALL resolve via PG-findFirst (existing
# IdempotencyKeyConcern behaviour) without ever reaching the claim path.
info "burst 2 — 20 same-key triggers (post-materialisation)"
B2=$WORK/burst2
mkdir -p "$B2"
for i in $(seq 1 20); do
  curl -s -o "$B2/$i.json" -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i,\"phase\":2},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" &
done
wait

declare -a IDS2=()
for f in "$B2"/*.json; do
  id=$(jq -r '.id // empty' "$f")
  if [[ -n "$id" ]]; then IDS2+=( "$id" ); fi
done
U2=$(printf "%s\n" "${IDS2[@]}" | sort -u)
n2=$(echo "$U2" | wc -l | tr -d ' ')
info "burst 2: ${#IDS2[@]} responses, $n2 unique runId(s)"

if [[ "$n2" == "1" ]]; then
  pass "burst 2 converged on one runId"
else
  fail "burst 2 produced $n2 unique runIds — PG-cache resolution broken"
fi

SHARED=$(echo "$U2" | head -1)
if [[ "$SHARED" == "$WINNER" ]]; then
  pass "burst 2's runId matches burst 1's winner — cross-store dedup intact"
else
  fail "burst 2 runId=$SHARED, burst 1 winner=$WINNER — they should match"
fi

# Burst 2 should be ALL isCached:true (PG-findFirst hit).
CACHED2=$(jq -s 'map(select(.isCached == true)) | length' "$B2"/*.json)
if [[ "$CACHED2" == "20" ]]; then
  pass "all 20 burst-2 responses are isCached:true (PG cache hit, not claim)"
else
  fail "burst 2 had $CACHED2/20 isCached:true responses"
fi

summary
