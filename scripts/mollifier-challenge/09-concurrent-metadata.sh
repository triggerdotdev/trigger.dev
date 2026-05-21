#!/usr/bin/env bash
# 09 — concurrent metadata.increment against the same buffered run.
# CAS retry loop must not lose deltas. Fires 50 increments-of-1; final
# counter should be exactly 50.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Concurrent metadata increments — CAS atomicity"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "buffered runId: $BUFFERED_ID"

# Seed the counter to 0.
api PUT "/api/v1/runs/$BUFFERED_ID/metadata" '{"metadata":{"counter":0}}'
if last_status_ok; then
  pass "seeded counter=0"
else
  fail "seed status=$(cat "$WORK/last.status")"
  summary
fi

# Fire 50 concurrent increment PUTs.
CONCURRENT=${CONCURRENT:-50}
info "firing $CONCURRENT concurrent increment-by-1 PUTs"
incr_dir=$WORK/incr
mkdir -p "$incr_dir"
for i in $(seq 1 "$CONCURRENT"); do
  curl -s -o "$incr_dir/$i.body" -w "%{http_code}\n" -X PUT \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"operations":[{"type":"increment","key":"counter","value":1}]}' \
    "$API_BASE/api/v1/runs/$BUFFERED_ID/metadata" \
    > "$incr_dir/$i.status" &
done
wait

ok_count=0
fail_count=0
for f in "$incr_dir"/*.status; do
  s=$(cat "$f")
  if [[ "$s" =~ ^2 ]]; then
    ok_count=$((ok_count + 1))
  else
    fail_count=$((fail_count + 1))
  fi
done
info "ok responses: $ok_count / $CONCURRENT (non-2xx: $fail_count)"

if [[ "$ok_count" -lt "$CONCURRENT" ]]; then
  fail "$fail_count increments returned non-2xx — CAS retries exhausted?"
fi

# Read back the counter.
api GET "/api/v1/runs/$BUFFERED_ID/metadata"
counter=$(last_body | jq -r '(.metadata // "" | fromjson? // {}) | .counter // "missing"')
if [[ "$counter" == "$CONCURRENT" ]]; then
  pass "final counter=$counter (no lost deltas under $CONCURRENT-way concurrency)"
else
  fail "expected counter=$CONCURRENT, got counter=$counter — Lua CAS lost deltas"
fi

summary
