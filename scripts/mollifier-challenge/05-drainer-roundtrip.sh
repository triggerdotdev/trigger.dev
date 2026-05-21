#!/usr/bin/env bash
# 05 — pre-mutate a buffered run with tags + metadata; enable the drainer;
# wait for materialisation; verify the PG row carries the mutations.
# Required: drainer OFF initially, then ON after the pre-mutate step.
#
# Workflow:
#   1. Run with drainer OFF: this script buffers + mutates, then pauses.
#   2. While paused, restart the webapp with TRIGGER_MOLLIFIER_DRAINER_ENABLED=1.
#   3. Press Enter; the script polls for materialisation + checks the PG row.

source "$(dirname "$0")/00-lib.sh"

header "Drainer round-trip: buffered + mutated → materialised PG row"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
info "buffered runId: $BUFFERED_ID"

# Pre-mutate
api POST "/api/v1/runs/$BUFFERED_ID/tags" '{"tags":["drained-tag"]}'
if last_status_ok; then pass "tags-add 2xx"; else fail "tags-add status=$(cat "$WORK/last.status")"; fi
api PUT "/api/v1/runs/$BUFFERED_ID/metadata" '{"metadata":{"drained":true}}'
if last_status_ok; then pass "metadata-put 2xx"; else fail "metadata-put status=$(cat "$WORK/last.status")"; fi

echo
echo "${C_WARN}=== ACTION REQUIRED ===${C_RESET}"
echo "Restart the webapp with:"
echo "  TRIGGER_MOLLIFIER_DRAINER_ENABLED=1 pnpm run dev --filter webapp"
echo "Then press Enter to continue."
read -r _

header "Polling for materialisation"
deadline=$(($(date +%s) + 60))
materialised=""
while (( $(date +%s) < deadline )); do
  api GET "/api/v3/runs/$BUFFERED_ID" >/dev/null
  status=$(last_body | jq -r '.status // empty')
  if [[ "$status" != "PENDING" && "$status" != "QUEUED" && "$status" != "DELAYED" && -n "$status" ]]; then
    materialised="$status"
    break
  fi
  # Also accept if PG-canonical retrieve returns full TaskRun shape (the
  # snapshot synthesis only fills a subset of fields).
  if last_body | jq -e '.completedAt or .startedAt or (.attempts | length > 0)' >/dev/null 2>&1; then
    materialised="materialised"
    break
  fi
  sleep 1
done

if [[ -z "$materialised" ]]; then
  fail "run did not materialise within 60s — is the drainer actually enabled?"
  summary
fi
pass "run materialised (status=$materialised)"

# Verify mutations survived materialisation.
api GET "/api/v3/runs/$BUFFERED_ID"
if body_matches '.runTags // [] | any(. == "drained-tag")'; then
  pass "tags survived materialisation"
else
  fail "tags lost — runTags=$(last_body | jq -c '.runTags // []')"
fi

api GET "/api/v1/runs/$BUFFERED_ID/metadata"
if body_matches '(.metadata // "" | tostring) | contains("\"drained\":true")'; then
  pass "metadata survived materialisation"
else
  fail "metadata lost — body=$(last_body | head -c 200)"
fi

summary
