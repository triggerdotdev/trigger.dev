#!/usr/bin/env bash
# 03 — each mutation lands on the snapshot (verified by follow-up read).
# Cancel is left for 06-cancel-bifurcation.sh because it terminates the
# snapshot. Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Mutations land on the buffered snapshot"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "using buffered runId: $BUFFERED_ID"

# --- tags ---
header "tags-add → readback"
api POST "/api/v1/runs/$BUFFERED_ID/tags" '{"tags":["challenge-tag-a","challenge-tag-b"]}'
if last_status_ok; then
  pass "POST /tags returned 2xx"
else
  fail "POST /tags status=$(cat "$WORK/last.status")"
fi
api GET "/api/v3/runs/$BUFFERED_ID"
if body_matches '.runTags // [] | (any(. == "challenge-tag-a") and any(. == "challenge-tag-b"))'; then
  pass "retrieve shows both new tags on the snapshot"
else
  fail "retrieve runTags=$(last_body | jq -c '.runTags // []')"
fi

# Idempotent dedup
api POST "/api/v1/runs/$BUFFERED_ID/tags" '{"tags":["challenge-tag-a"]}'
api GET "/api/v3/runs/$BUFFERED_ID"
tag_count=$(last_body | jq '.runTags // [] | map(select(. == "challenge-tag-a")) | length')
if [[ "$tag_count" == "1" ]]; then
  pass "duplicate tag deduplicated by mutateSnapshot Lua"
else
  fail "duplicate tag landed $tag_count times (expected 1)"
fi

# --- metadata-put replace ---
header "metadata-put (replace) → readback"
api PUT "/api/v1/runs/$BUFFERED_ID/metadata" '{"metadata":{"phase":"challenge","attempt":1}}'
if last_status_ok; then
  pass "PUT /metadata returned 2xx"
else
  fail "PUT /metadata status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
fi
api GET "/api/v1/runs/$BUFFERED_ID/metadata"
if body_matches '(.metadata // "" | tostring) | (contains("\"phase\":\"challenge\"") and contains("\"attempt\":1"))'; then
  pass "GET /metadata reflects PUT"
else
  fail "metadata readback=$(last_body | head -c 200)"
fi

# --- metadata-put operations (increment) ---
header "metadata operations (increment) → readback"
api PUT "/api/v1/runs/$BUFFERED_ID/metadata" \
  '{"operations":[{"type":"increment","key":"counter","value":5}]}'
if last_status_ok; then
  pass "PUT /metadata (increment by 5) returned 2xx"
else
  fail "PUT /metadata increment status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
fi
api PUT "/api/v1/runs/$BUFFERED_ID/metadata" \
  '{"operations":[{"type":"increment","key":"counter","value":3}]}'
api GET "/api/v1/runs/$BUFFERED_ID/metadata"
if body_matches '(.metadata // "" | tostring) | contains("\"counter\":8")'; then
  pass "two increments produce counter=8 (CAS retry not losing deltas)"
else
  fail "counter after 5+3 = $(last_body | head -c 200)"
fi

# --- reschedule ---
header "reschedule → readback"
api POST "/api/v1/runs/$BUFFERED_ID/reschedule" '{"delay":"10m"}'
if last_status_ok; then
  pass "POST /reschedule returned 2xx"
else
  fail "POST /reschedule status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
fi
# Reschedule applies set_delay on the snapshot — no direct read-back via
# the public API (the snapshot delay is internal until materialise).
# This is by design; we accept the 2xx as the contract here.

summary
