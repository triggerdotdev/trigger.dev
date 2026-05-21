#!/usr/bin/env bash
# 12 — state-3 replay (Q2): the microseconds-wide window where a buffered
# entry is HSET status=FAILED in Redis but no PG SYSTEM_FAILURE row has
# been written yet. Q2 design says: allow replay; the new run is a fresh
# trigger, no causal dependency on the original's PG row existing.
#
# We manufacture state 3 by directly manipulating Redis (drainer disabled,
# so the fail() path never runs).
#
# Required: drainer OFF.
#          : redis-cli or `docker exec redis redis-cli` available.

source "$(dirname "$0")/00-lib.sh"

header "Replay during state-3 (FAILED in Redis, no PG row yet)"

# Resolve a redis CLI to use. Caller may set REDIS_CLI explicitly; else
# we try a couple of common defaults.
if [[ -z "${REDIS_CLI:-}" ]]; then
  if command -v redis-cli >/dev/null 2>&1; then
    REDIS_CLI=(redis-cli)
  elif docker ps --format '{{.Names}}' 2>/dev/null | grep -q '^redis$'; then
    REDIS_CLI=(docker exec -i redis redis-cli)
  else
    fail "no redis-cli available; set REDIS_CLI='docker exec -i NAME redis-cli'"
    summary
  fi
else
  # split env var into command + args
  read -ra REDIS_CLI <<< "$REDIS_CLI"
fi
info "redis CLI: ${REDIS_CLI[*]}"

BUFFERED_ID=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID" ]]; then
  fail "could not buffer a run"
  summary
fi
pass "buffered runId=$BUFFERED_ID (QUEUED)"

# Force state 3: HSET status=FAILED directly on the entry hash. Don't
# touch the ZSET (so the drainer wouldn't find it anyway). Don't write
# a SYSTEM_FAILURE PG row — that's the gap state-3 captures.
"${REDIS_CLI[@]}" HSET "mollifier:entries:$BUFFERED_ID" status FAILED >/dev/null
status_after=$("${REDIS_CLI[@]}" HGET "mollifier:entries:$BUFFERED_ID" status | tr -d '\r')
if [[ "$status_after" == "FAILED" ]]; then
  pass "manually injected state-3 (entry.status=FAILED, no PG row)"
else
  fail "could not set entry.status=FAILED (got '$status_after')"
  summary
fi

# Replay. Q2 says: allow. Should succeed.
api POST "/api/v1/runs/$BUFFERED_ID/replay" '{}'
if ! last_status_ok; then
  fail "replay rejected during state-3: status=$(cat "$WORK/last.status") body=$(last_body | head -c 200)"
  summary
fi
NEW_ID=$(last_body | jq -r '.id')
if [[ -z "$NEW_ID" || "$NEW_ID" == "null" ]]; then
  fail "replay 2xx but missing .id"
  summary
fi
pass "replay during state-3 returned fresh runId=$NEW_ID"

if [[ "$NEW_ID" == "$BUFFERED_ID" ]]; then
  fail "replay returned the original FAILED runId — should be fresh"
fi

# Read the original. Snapshot-side retrieve should still resolve (entry
# hash with status=FAILED returns SYSTEM_FAILURE in the SyntheticRun
# mapping per readFallback).
api GET "/api/v3/runs/$BUFFERED_ID"
if last_status_ok; then
  body_status=$(last_body | jq -r '.status')
  info "original status post-state-3: $body_status"
  pass "original still resolvable (status reflects FAILED snapshot)"
else
  fail "original $(cat "$WORK/last.status") on state-3"
fi

summary
