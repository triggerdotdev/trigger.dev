#!/usr/bin/env bash
# 07 — replay a buffered run. Verify a fresh PG run is created and the
# original buffered entry is untouched.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Replay a buffered run"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "original buffered runId: $BUFFERED_ID"

api POST "/api/v1/runs/$BUFFERED_ID/replay" '{}'
if ! last_status_ok; then
  fail "POST /replay status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
NEW_ID=$(last_body | jq -r '.id')
if [[ -z "$NEW_ID" || "$NEW_ID" == "null" ]]; then
  fail "replay response missing .id"
  summary
fi
pass "replay returned new runId: $NEW_ID"
if [[ "$NEW_ID" == "$BUFFERED_ID" ]]; then
  fail "replay returned the original runId — should be a fresh run"
else
  pass "new runId is distinct from the original"
fi

# Verify the original is still resolvable (snapshot untouched by the
# replay path — Q2 design).
api GET "/api/v3/runs/$BUFFERED_ID"
if last_status_ok; then
  pass "original buffered run still resolvable after replay"
else
  fail "original now $(cat "$WORK/last.status") — replay should leave it untouched"
fi

# Verify the new run exists too (either PG or buffered).
api GET "/api/v3/runs/$NEW_ID"
if last_status_ok; then
  pass "new replayed run is resolvable"
else
  fail "new run $(cat "$WORK/last.status")"
fi

summary
