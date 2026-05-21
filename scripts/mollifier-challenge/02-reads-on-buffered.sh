#!/usr/bin/env bash
# 02 — read endpoints all behave correctly on a buffered run.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Read endpoints on a buffered run"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run (rerun 01 to debug)"
  summary
fi
info "using buffered runId: $BUFFERED_ID"

# /api/v3/runs/{id}
api GET "/api/v3/runs/$BUFFERED_ID"
if last_status_ok && body_matches '.id and .taskIdentifier and .status'; then
  pass "GET /api/v3/runs/{id} — 2xx with id+taskIdentifier+status"
else
  fail "GET /api/v3/runs/{id} — status=$(cat "$WORK/last.status") body=$(last_body | head -c 100)"
fi

# /api/v1/runs/{id}/trace
api GET "/api/v1/runs/$BUFFERED_ID/trace"
if last_status_ok && body_matches '.trace and .trace.traceId'; then
  pass "GET /trace — 2xx with trace.traceId"
else
  fail "GET /trace — status=$(cat "$WORK/last.status") body=$(last_body | head -c 100)"
fi

# /api/v1/runs/{id}/events
api GET "/api/v1/runs/$BUFFERED_ID/events"
if last_status_ok && body_matches '.events | type == "array"'; then
  pass "GET /events — 2xx, events is an array"
else
  fail "GET /events — status=$(cat "$WORK/last.status") body=$(last_body | head -c 100)"
fi

# /api/v1/runs/{id}/attempts
api GET "/api/v1/runs/$BUFFERED_ID/attempts"
if last_status_ok && body_matches '.attempts | type == "array" and length == 0'; then
  pass "GET /attempts — 2xx, attempts is empty array"
else
  fail "GET /attempts — status=$(cat "$WORK/last.status") body=$(last_body | head -c 100)"
fi

# /api/v1/runs/{id}/metadata (loader)
api GET "/api/v1/runs/$BUFFERED_ID/metadata"
if last_status_ok && body_matches 'has("metadata") and has("metadataType")'; then
  pass "GET /metadata — 2xx with { metadata, metadataType }"
else
  fail "GET /metadata — status=$(cat "$WORK/last.status") body=$(last_body | head -c 100)"
fi

# /api/v1/runs/{id}/result — expected 404 (run not finished)
api GET "/api/v1/runs/$BUFFERED_ID/result"
status=$(cat "$WORK/last.status")
if [[ "$status" == "404" ]]; then
  pass "GET /result — 404 (run not finished, expected contract)"
else
  fail "GET /result — expected 404, got $status"
fi

# Spans endpoint — buffered run only has the queued span; 404 for any other.
SPAN_ID=$(api GET "/api/v3/runs/$BUFFERED_ID" >/dev/null; last_body | jq -r '.spanId // empty')
if [[ -n "$SPAN_ID" ]]; then
  api GET "/api/v1/runs/$BUFFERED_ID/spans/$SPAN_ID"
  if last_status_ok; then
    pass "GET /spans/{spanId} — 2xx for the queued span"
  else
    fail "GET /spans/{spanId} — expected 2xx, got $(cat "$WORK/last.status")"
  fi

  api GET "/api/v1/runs/$BUFFERED_ID/spans/nonexistent_span_xyz"
  if [[ "$(cat "$WORK/last.status")" == "404" ]]; then
    pass "GET /spans/{unknown} — 404"
  else
    fail "GET /spans/{unknown} — expected 404, got $(cat "$WORK/last.status")"
  fi
else
  info "skipping spans probe — no spanId on retrieve response"
fi

summary
