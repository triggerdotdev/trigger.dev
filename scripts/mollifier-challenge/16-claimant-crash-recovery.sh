#!/usr/bin/env bash
# 16 — claimant-crash recovery. The trigger pipeline's try/catch must
# release the claim so polling waiters can retry. We simulate by
# planting a "pending" claim externally, firing N same-key triggers
# (all polling), DEL-ing the claim mid-poll to simulate a release,
# and verifying one of the waiters re-claims + succeeds.
#
# Required: drainer OFF + redis-cli.

source "$(dirname "$0")/00-lib.sh"

header "Claimant-crash recovery: release → waiter re-claim"

if [[ -z "${REDIS_CLI:-}" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then REDIS_CLI=(redis-cli)
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^redis$'; then
    REDIS_CLI=(docker exec -i redis redis-cli)
  else fail "no redis-cli; set REDIS_CLI"; summary; fi
else read -ra REDIS_CLI <<< "$REDIS_CLI"
fi

KEY="challenge-crash-$(date +%s)-$RANDOM"
CLAIM_KEY="mollifier:claim:${ENV_ID:?ENV_ID required}:$TASK_ID:$KEY"

# Pre-plant a "pending" claim so all incoming triggers will poll.
"${REDIS_CLI[@]}" SET "$CLAIM_KEY" "pending" EX 60 >/dev/null
info "planted pending claim at $CLAIM_KEY"

# Fire 5 same-key triggers in parallel — all should enter poll mode.
WAITERS=$WORK/w
mkdir -p "$WAITERS"
for i in $(seq 1 5); do
  curl -s -o "$WAITERS/$i.json" -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" &
done

# After 1 second, simulate the claimant's release by DEL-ing the claim
# key. Polling waiters should detect the absent key, retry SETNX, and
# one of them should win + proceed.
sleep 1
"${REDIS_CLI[@]}" DEL "$CLAIM_KEY" >/dev/null
info "released pending claim (DEL fired)"

wait

# Collect runIds.
declare -a IDS=()
for f in "$WAITERS"/*.json; do
  id=$(jq -r '.id // empty' "$f")
  if [[ -n "$id" ]]; then IDS+=( "$id" ); fi
done
UNIQUE=$(printf "%s\n" "${IDS[@]}" | sort -u)
n=$(echo "$UNIQUE" | wc -l | tr -d ' ')

info "responses: ${#IDS[@]}, unique runIds: $n"
echo "$UNIQUE" | head -3 | while read -r id; do info "  $id"; done

if [[ "$n" == "1" ]]; then
  pass "all 5 waiters resolved to one runId after release"
else
  fail "expected 1 unique runId, got $n — retry path broken?"
fi

NOT_CACHED=$(jq -s 'map(select(.isCached == false)) | length' "$WAITERS"/*.json)
if [[ "$NOT_CACHED" == "1" ]]; then
  pass "exactly one waiter became the new claimant (isCached:false)"
else
  fail "expected 1 isCached:false response, got $NOT_CACHED"
fi

summary
