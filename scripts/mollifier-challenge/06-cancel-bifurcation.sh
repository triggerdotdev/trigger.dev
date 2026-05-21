#!/usr/bin/env bash
# 06 — cancel a buffered run; toggle drainer on; verify the PG row lands
# in CANCELED state (drainer-bifurcation routes through createCancelledRun,
# not engine.trigger).
# Required: drainer OFF initially, ON during the polling phase.

source "$(dirname "$0")/00-lib.sh"

header "Cancel bifurcation: buffered cancel → CANCELED PG row"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "buffered runId: $BUFFERED_ID"

# Stamp cancel on the snapshot via the public v2 cancel API.
api POST "/api/v2/runs/$BUFFERED_ID/cancel" '{}'
if last_status_ok; then
  pass "POST /api/v2/runs/{id}/cancel returned 2xx"
else
  fail "cancel API status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi

# Read-back: snapshot should now reflect cancelledAt (synthesised retrieve
# doesn't expose cancelledAt directly — but a second cancel call is
# idempotent and should also return 2xx).
api POST "/api/v2/runs/$BUFFERED_ID/cancel" '{}'
if last_status_ok; then
  pass "second cancel call also 2xx (idempotent)"
else
  fail "second cancel status=$(cat "$WORK/last.status")"
fi

echo
echo "${C_WARN}=== ACTION REQUIRED ===${C_RESET}"
echo "Restart the webapp with:"
echo "  TRIGGER_MOLLIFIER_DRAINER_ENABLED=1 pnpm run dev --filter webapp"
echo "Then press Enter to continue."
read -r _

header "Polling for CANCELED materialisation"
deadline=$(($(date +%s) + 60))
landed=""
while (( $(date +%s) < deadline )); do
  api GET "/api/v3/runs/$BUFFERED_ID" >/dev/null
  status=$(last_body | jq -r '.status // empty')
  if [[ "$status" == "CANCELED" ]]; then
    landed="yes"
    break
  fi
  sleep 1
done

if [[ -z "$landed" ]]; then
  fail "run did not land in CANCELED within 60s (current status: $(last_body | jq -r .status))"
  summary
fi
pass "run materialised in CANCELED via engine.createCancelledRun"

# Verify the cancellation reason / completedAt presence.
if body_matches '.completedAt != null'; then
  pass "completedAt set"
else
  fail "completedAt is null on cancelled run"
fi

# A subsequent cancel via the API should be idempotent against the PG row
# (existing service returns alreadyFinished:true semantically).
api POST "/api/v2/runs/$BUFFERED_ID/cancel" '{}'
if last_status_ok; then
  pass "post-materialise cancel is idempotent"
else
  fail "post-materialise cancel status=$(cat "$WORK/last.status")"
fi

summary
