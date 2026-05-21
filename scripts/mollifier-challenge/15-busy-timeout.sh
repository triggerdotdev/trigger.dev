#!/usr/bin/env bash
# 15 — mutateWithFallback "busy" path → safety-net timeout → 503.
# When mutateSnapshot returns busy (entry DRAINING / FAILED /
# materialised=true) the helper polls the PG writer for ~2s, then
# 503s if the row never materialises. We force the busy state by
# HSET-ing the entry hash directly, then call a mutation endpoint
# and expect 503 within ~2.5s.
#
# Required: drainer OFF (so the entry stays in whatever state we set).
#          : redis-cli or `docker exec redis redis-cli`.

source "$(dirname "$0")/00-lib.sh"

header "mutateWithFallback busy → safety-net timeout"

if [[ -z "${REDIS_CLI:-}" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then
    REDIS_CLI=(redis-cli)
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^redis$'; then
    REDIS_CLI=(docker exec -i redis redis-cli)
  else
    fail "no redis-cli; set REDIS_CLI='docker exec -i NAME redis-cli'"
    summary
  fi
else
  read -ra REDIS_CLI <<< "$REDIS_CLI"
fi

# Test each of the three "busy" trigger states. Each one buffers a fresh
# run, mutates the entry into the target state via redis-cli, then calls
# a mutation API and expects 503 (not 5xx, not 200 — explicit timeout).
test_busy_state() {
  local label=$1 hset_args=("${@:2}")

  BUFFERED_ID=$(capture_buffered_run_id)
  if [[ -z "$BUFFERED_ID" ]]; then
    fail "[$label] could not buffer a run"
    return
  fi

  # Verify the entry is initially mutable.
  api POST "/api/v1/runs/$BUFFERED_ID/tags" '{"tags":["pre-busy"]}'
  if ! last_status_ok; then
    fail "[$label] pre-busy tags status=$(cat "$WORK/last.status")"
    return
  fi

  # Force the busy state.
  "${REDIS_CLI[@]}" HSET "mollifier:entries:$BUFFERED_ID" "${hset_args[@]}" >/dev/null
  info "[$label] HSET ${hset_args[*]} on $BUFFERED_ID"

  # Fire a mutation. Should 503 after ~2s of polling.
  local t0 t1
  t0=$(date +%s)
  api POST "/api/v1/runs/$BUFFERED_ID/tags" '{"tags":["during-busy"]}'
  t1=$(date +%s)
  local elapsed=$((t1 - t0))
  local status
  status=$(cat "$WORK/last.status")

  if [[ "$status" == "503" ]]; then
    pass "[$label] returned 503 in ${elapsed}s (expected ~2s)"
  else
    fail "[$label] expected 503, got $status in ${elapsed}s — body=$(last_body | head -c 200)"
  fi

  if (( elapsed >= 1 && elapsed <= 5 )); then
    pass "[$label] wait time in [1, 5]s window (safetyNetMs=2000)"
  else
    fail "[$label] wait time ${elapsed}s outside expected [1, 5]s window"
  fi
}

header "busy state 1: status=DRAINING"
test_busy_state "DRAINING" status DRAINING

header "busy state 2: status=FAILED"
test_busy_state "FAILED" status FAILED

header "busy state 3: materialised=true"
test_busy_state "materialised" materialised true

summary
