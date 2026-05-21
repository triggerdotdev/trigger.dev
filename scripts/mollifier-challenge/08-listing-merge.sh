#!/usr/bin/env bash
# 08 — buffered runs appear in /api/v1/runs listings, in createdAt-DESC
# order, paginating across the buffer→PG boundary correctly.
# Required: drainer OFF.

source "$(dirname "$0")/00-lib.sh"

header "Listing merges buffered + PG runs"

# Set up a known PG run first (so we have an anchor below the buffer).
api POST "/api/v1/tasks/$TASK_ID/trigger" '{"payload":{"pg":true},"options":{"delay":"5m"}}'
if ! last_status_ok; then
  fail "control trigger failed: $(cat "$WORK/last.status")"
  summary
fi
PG_ID=$(last_body | jq -r '.id')
info "PG anchor runId: $PG_ID"

# Buffer one.
BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "buffered runId: $BUFFERED_ID"

# List with a generous page size — both should appear.
api GET "/api/v1/runs?page%5Bsize%5D=100"
if ! last_status_ok; then
  fail "GET /api/v1/runs status=$(cat "$WORK/last.status")"
  summary
fi
if body_matches --arg id "$BUFFERED_ID" '.data | any(.id == $id)' 2>/dev/null; then
  pass "buffered runId appears in the page"
else
  if jq -e --arg id "$BUFFERED_ID" '.data | any(.id == $id)' "$WORK/last.body" >/dev/null 2>&1; then
    pass "buffered runId appears in the page"
  else
    fail "buffered runId $BUFFERED_ID missing from /api/v1/runs"
  fi
fi
if jq -e --arg id "$PG_ID" '.data | any(.id == $id)' "$WORK/last.body" >/dev/null 2>&1; then
  pass "PG-anchor runId also appears in the page"
else
  info "PG anchor not in this page — listing may be paginated below it"
fi

# Verify ordering: buffered runs (newer) should appear above the PG-anchor.
buffered_index=$(jq --arg id "$BUFFERED_ID" \
  '[.data | to_entries[] | select(.value.id == $id) | .key] | first // -1' \
  "$WORK/last.body")
pg_index=$(jq --arg id "$PG_ID" \
  '[.data | to_entries[] | select(.value.id == $id) | .key] | first // -1' \
  "$WORK/last.body")
if [[ "$buffered_index" -ge 0 && "$pg_index" -ge 0 ]]; then
  if (( buffered_index < pg_index )); then
    pass "buffered run sorts above the older PG-anchor (createdAt DESC)"
  else
    fail "buffered at index $buffered_index, PG at $pg_index — ordering wrong"
  fi
fi

# Pagination: take page[size]=1 and walk pages, accumulate ids.
header "Pagination across buffer/PG boundary"
collected=()
cursor=""
for i in $(seq 1 10); do
  if [[ -n "$cursor" ]]; then
    api GET "/api/v1/runs?page%5Bsize%5D=2&page%5Bafter%5D=$(printf %s "$cursor" | jq -sRr @uri)"
  else
    api GET "/api/v1/runs?page%5Bsize%5D=2"
  fi
  if ! last_status_ok; then
    fail "page $i status=$(cat "$WORK/last.status")"
    break
  fi
  page_ids=$(jq -r '.data[].id' "$WORK/last.body")
  for id in $page_ids; do
    collected+=( "$id" )
  done
  cursor=$(jq -r '.pagination.next // empty' "$WORK/last.body")
  if [[ -z "$cursor" ]]; then
    info "no next cursor on page $i — listing exhausted"
    break
  fi
done
total=${#collected[@]}
unique=$(printf "%s\n" "${collected[@]}" | sort -u | wc -l | tr -d ' ')
info "walked $total entries across pages, $unique unique"
if [[ "$total" == "$unique" ]]; then
  pass "pagination has no duplicates across pages"
else
  fail "found $((total - unique)) duplicates while walking pages"
fi

summary
