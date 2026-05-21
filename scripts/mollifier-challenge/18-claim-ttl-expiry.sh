#!/usr/bin/env bash
# 18 — claim safety-net timeout. Plant a "pending" claim with a TTL
# longer than the wait safety net (default 5s); fire a same-key trigger;
# verify it polls for the safetyNet and returns 503 (not 200, not 5xx,
# not a fresh trigger).
#
# Required: drainer OFF + redis-cli.

source "$(dirname "$0")/00-lib.sh"

header "Claim safety-net timeout"

if [[ -z "${REDIS_CLI:-}" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then REDIS_CLI=(redis-cli)
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^redis$'; then
    REDIS_CLI=(docker exec -i redis redis-cli)
  else fail "no redis-cli; set REDIS_CLI"; summary; fi
else read -ra REDIS_CLI <<< "$REDIS_CLI"
fi

KEY="challenge-ttl-$(date +%s)-$RANDOM"
CLAIM_KEY="mollifier:claim:${ENV_ID:?ENV_ID required}:$TASK_ID:$KEY"

# Plant "pending" with TTL=20s — comfortably outlives the 5s safety net.
"${REDIS_CLI[@]}" SET "$CLAIM_KEY" "pending" EX 20 >/dev/null
info "planted long-lived pending claim ($CLAIM_KEY, TTL=20s)"

# Fire a same-key trigger. Time the response.
t0=$(date +%s)
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"x\":1},\"options\":{\"idempotencyKey\":\"$KEY\"}}"
t1=$(date +%s)
elapsed=$((t1 - t0))
status=$(cat "$WORK/last.status")

info "response status=$status, elapsed=${elapsed}s"
info "body: $(last_body | head -c 200)"

if [[ "$status" == "503" ]]; then
  pass "returned 503 (safety net hit)"
else
  fail "expected 503, got $status"
fi

# Wait should be ~5s (safetyNetMs default). Accept [4, 8] to absorb
# polling jitter and webapp overhead.
if (( elapsed >= 4 && elapsed <= 8 )); then
  pass "wait time ${elapsed}s ≈ safetyNetMs (5s)"
else
  fail "wait time ${elapsed}s outside [4, 8]s — safetyNet misconfigured?"
fi

# Cleanup so other tests don't see stale pending.
"${REDIS_CLI[@]}" DEL "$CLAIM_KEY" >/dev/null

summary
