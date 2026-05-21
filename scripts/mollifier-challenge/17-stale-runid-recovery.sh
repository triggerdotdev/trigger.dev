#!/usr/bin/env bash
# 17 — stale-runId recovery. The claim resolves to a runId that exists
# in neither PG nor the buffer (e.g., claimant errored after publish, or
# both stores expired). IdempotencyKeyConcern should detect this, log a
# warn, and fall through to a fresh trigger rather than echoing the
# dead runId.
#
# Required: drainer OFF + redis-cli.

source "$(dirname "$0")/00-lib.sh"

header "Stale-runId recovery: claim points at a ghost"

if [[ -z "${REDIS_CLI:-}" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then REDIS_CLI=(redis-cli)
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^redis$'; then
    REDIS_CLI=(docker exec -i redis redis-cli)
  else fail "no redis-cli; set REDIS_CLI"; summary; fi
else read -ra REDIS_CLI <<< "$REDIS_CLI"
fi

KEY="challenge-stale-$(date +%s)-$RANDOM"
CLAIM_KEY="mollifier:claim:${ENV_ID:?ENV_ID required}:$TASK_ID:$KEY"
GHOST_ID="run_doesnotexist_$(date +%s)"

# Plant a claim that points at a non-existent runId.
"${REDIS_CLI[@]}" SET "$CLAIM_KEY" "$GHOST_ID" EX 60 >/dev/null
info "planted stale claim: $CLAIM_KEY -> $GHOST_ID"

# Fire a same-key trigger. IdempotencyKeyConcern's flow:
#   1. claimOrAwait → returns { resolved, runId: ghost }
#   2. PG findFirst(idempotencyKey=K) → miss (no row)
#   3. findBufferedRunWithIdempotency → miss
#   4. Log warn ("claim resolved but runId not findable"), fall through
#   5. The trigger proceeds normally and SHOULD create a fresh new run
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"x\":1},\"options\":{\"idempotencyKey\":\"$KEY\"}}"
if ! last_status_ok; then
  fail "trigger returned $(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
NEW_ID=$(last_body | jq -r '.id')
NEW_CACHED=$(last_body | jq -r '.isCached')

if [[ "$NEW_ID" == "$GHOST_ID" ]]; then
  fail "trigger returned the ghost runId — fall-through broken"
elif [[ "$NEW_CACHED" == "true" ]]; then
  fail "trigger returned isCached:true (id=$NEW_ID) — should be fresh"
else
  pass "fresh runId returned: $NEW_ID (isCached:false)"
fi

# Verify the new run is actually resolvable (not another ghost).
api GET "/api/v3/runs/$NEW_ID"
if last_status_ok; then
  pass "new runId is resolvable"
else
  fail "new runId $(cat "$WORK/last.status")"
fi

summary
