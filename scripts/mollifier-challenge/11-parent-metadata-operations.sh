#!/usr/bin/env bash
# 11 — parent/root metadata operations on a buffered child run.
# The route's `routeOperationsToRun` helper fans body.parentOperations
# out to the buffered run's parentTaskRunId via the existing
# UpdateMetadataService. Verifies the C3 parent/root fan-out works
# when the child is in the buffer.
#
# Required: drainer OFF.
#
# Setup nuance:
#   - The parent run must be in PG and "updatable" (not COMPLETED, etc).
#     We use a DELAYED parent (delay=10m) so it sits in DELAYED state
#     and accepts metadata operations.
#   - The child trigger uses options.parentRunId. To ensure the child
#     mollifies into the buffer we fire it inside a burst.

source "$(dirname "$0")/00-lib.sh"

header "Parent/root metadata operations from a buffered child"

# Step 1: create a PG parent run (delayed so it stays updatable).
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  '{"payload":{"role":"parent"},"options":{"delay":"10m"}}'
if ! last_status_ok; then
  fail "parent trigger failed: $(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
PARENT_ID=$(last_body | jq -r '.id')
if [[ -z "$PARENT_ID" || "$PARENT_ID" == "null" ]]; then
  fail "parent trigger response missing .id"
  summary
fi
pass "PG parent runId=$PARENT_ID (DELAYED)"

# Step 2: burst children with parentRunId set; capture one buffered child.
BURST_DIR=$WORK/burst
mkdir -p "$BURST_DIR"
for i in $(seq 1 "$BURST_SIZE"); do
  curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i,\"role\":\"child\"},\"options\":{\"parentRunId\":\"$PARENT_ID\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" \
    -o "$BURST_DIR/$i.json" &
done
wait

CHILD_ID=""
for f in "$BURST_DIR"/*.json; do
  if jq -e '.notice.code == "mollifier.queued"' "$f" >/dev/null 2>&1; then
    CHILD_ID=$(jq -r '.id' "$f")
    break
  fi
done

if [[ -z "$CHILD_ID" ]]; then
  fail "no buffered child run — gate not tripping"
  summary
fi
pass "buffered child runId=$CHILD_ID"

# Step 3: PUT metadata with parentOperations on the child. The fanout
# in routeOperationsToRun should apply these to the PG parent.
api PUT "/api/v1/runs/$CHILD_ID/metadata" \
  '{"operations":[{"type":"set","key":"child","value":"value"}],"parentOperations":[{"type":"set","key":"fromChild","value":42}]}'

if ! last_status_ok; then
  fail "PUT /metadata with parentOperations status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
pass "PUT /metadata with parentOperations returned 2xx"

# Step 4: read parent's metadata and confirm the operation landed.
# Allow a small delay for the metadata-batching worker to flush.
info "polling parent metadata for fromChild=42"
landed=""
deadline=$(($(date +%s) + 10))
while (( $(date +%s) < deadline )); do
  api GET "/api/v1/runs/$PARENT_ID/metadata"
  if last_status_ok && body_matches '(.metadata // "" | tostring) | contains("\"fromChild\":42")'; then
    landed="yes"
    break
  fi
  sleep 1
done

if [[ "$landed" == "yes" ]]; then
  pass "parent metadata reflects parentOperations from the buffered child"
else
  fail "parent metadata never showed fromChild=42 — body=$(last_body | head -c 200)"
fi

# Step 5: verify the child's own metadata also landed (the .child=value
# from the same PUT — that's the buffered-side CAS apply).
api GET "/api/v1/runs/$CHILD_ID/metadata"
if body_matches '(.metadata // "" | tostring) | contains("\"child\":\"value\"")'; then
  pass "child's own snapshot metadata reflects body.operations"
else
  fail "child metadata missing — body=$(last_body | head -c 200)"
fi

summary
