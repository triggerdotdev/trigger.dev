#!/usr/bin/env bash
# 01 — fire a burst, confirm the gate mollifies at least one trigger,
# capture the buffered runId, sanity-check the response shape.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Burst baseline"

info "firing $BURST_SIZE concurrent triggers against $TASK_ID"
BUFFERED_ID=$(capture_buffered_run_id)

if [[ -z "$BUFFERED_ID" ]]; then
  fail "no mollifier.queued response across $BURST_SIZE triggers"
  info "check: TRIGGER_MOLLIFIER_ENABLED=1, org flag on, threshold low, drainer OFF"
  summary
fi
pass "captured buffered runId: $BUFFERED_ID"

# Inspect via /api/v3/runs/{id} — should resolve via the buffer read-fallback
# even though the run isn't in PG.
api GET "/api/v3/runs/$BUFFERED_ID"
if last_status_ok; then
  pass "retrieve returns 2xx for the buffered run"
else
  fail "retrieve returned $(cat "$WORK/last.status") (expected 2xx)"
fi

if body_matches '.id == "'"$BUFFERED_ID"'"'; then
  pass "retrieve body carries the right runId"
else
  fail "retrieve body missing runId"
fi

if body_matches '.status == "PENDING" or .status == "QUEUED" or .status == "DELAYED"'; then
  pass "retrieve status is QUEUED-equivalent ($(last_body | jq -r .status))"
else
  fail "retrieve status unexpected: $(last_body | jq -r .status)"
fi

# Sanity: control trigger with a long delay should be in PG, not mollified.
header "Control sanity"
api POST "/api/v1/tasks/$TASK_ID/trigger" '{"payload":{"control":true},"options":{"delay":"10m"}}'
if last_status_ok; then
  CONTROL_ID=$(last_body | jq -r '.id')
  if [[ -n "$CONTROL_ID" && "$CONTROL_ID" != "null" ]]; then
    if last_body | jq -e '.notice.code == "mollifier.queued"' >/dev/null 2>&1; then
      fail "control trigger with delay was mollified — check threshold / hold settings"
    else
      pass "control trigger landed in PG (delayed), runId: $CONTROL_ID"
    fi
  else
    fail "control trigger response missing id"
  fi
else
  fail "control trigger returned $(cat "$WORK/last.status")"
fi

summary
