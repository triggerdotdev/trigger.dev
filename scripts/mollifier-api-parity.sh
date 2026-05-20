#!/usr/bin/env bash
#
# mollifier-api-parity.sh
#
# Verify that every public run-id-shaped API endpoint behaves the same
# whether the run lives in Postgres (normal path) or only in the
# mollifier Redis buffer (burst-protection path).
#
# Strategy: trigger TWO runs in identical pre-execution states and probe
# both through the same endpoint set.
#
#   - CONTROL run:  a single trigger with a long `delay` option so the
#                   run lands in Postgres in DELAYED state and the
#                   worker never picks it up. This is the "definitely
#                   in PG, no execution yet" baseline.
#
#   - BUFFERED run: one runId from a parallel burst that the mollifier
#                   diverted into the Redis buffer. With the drainer
#                   paused this run sits in Redis only — no PG row.
#
# Both runs are pre-execution, so any difference in response status or
# shape between the two is genuinely a Redis-vs-Postgres divergence,
# not a "the task ran on one and not the other" race condition.
#
# Usage:
#   API_KEY=tr_dev_... [API_BASE=http://localhost:3030] \
#   [ENV_ID=...]  [TASK_ID=hello-world] [BURST_SIZE=30] \
#   [CONTROL_DELAY=10m] \
#   ./scripts/mollifier-api-parity.sh
#
# Pre-flight:
#   - Webapp running, mollifier enabled, drainer PAUSED
#     (TRIGGER_MOLLIFIER_DRAINER_ENABLED=0) so the buffered run doesn't
#     evaporate mid-probe.
#   - Org has mollifierEnabled=true.
#   - TRIGGER_MOLLIFIER_TRIP_THRESHOLD low enough that the burst trips
#     the gate (defaults of 2/2000ms work for local dev).
#
# Exit code:
#   0  every endpoint matched the control's status code (true parity)
#   1  one or more endpoints diverged

set -uo pipefail

API_BASE=${API_BASE:-http://localhost:3030}
TASK_ID=${TASK_ID:-hello-world}
BURST_SIZE=${BURST_SIZE:-30}
CONTROL_DELAY=${CONTROL_DELAY:-10m}

if [[ -z "${API_KEY:-}" ]]; then
  echo "ERROR: API_KEY env var is required (tr_dev_... token for the target env)" >&2
  exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 2
fi

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

if [[ -t 1 ]]; then
  c_ok=$'\033[32m'; c_fail=$'\033[31m'; c_warn=$'\033[33m'; c_dim=$'\033[2m'; c_reset=$'\033[0m'
else
  c_ok=; c_fail=; c_warn=; c_dim=; c_reset=
fi

# ----------------------------------------------------------------------
# helpers
# ----------------------------------------------------------------------

# call METHOD PATH OUT_PREFIX [DATA]
# writes <prefix>.status (HTTP code) and <prefix>.body (raw body, 200 char preview)
call() {
  local method=$1 path=$2 prefix=$3 data=${4:-}
  local body_file=$WORK/$prefix.body
  local status_file=$WORK/$prefix.status
  local args=( -s -o "$body_file" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $API_KEY" )
  if [[ -n "$data" ]]; then
    args+=( -H "Content-Type: application/json" -d "$data" )
  fi
  args+=( "$API_BASE$path" )
  curl "${args[@]}" > "$status_file"
}

# 80-char body preview, newlines stripped
body_preview() {
  local file=$1
  tr -d '\n' < "$file" 2>/dev/null | head -c 80
}

pass_count=0
fail_count=0
declare -a failures=()

# probe_compare LABEL METHOD PATH_TEMPLATE [DATA]
#   PATH_TEMPLATE uses {ID} as the placeholder for the runId
probe_compare() {
  local label=$1 method=$2 path_template=$3 data=${4:-}

  local control_path="${path_template//\{ID\}/$CONTROL_ID}"
  local buffered_path="${path_template//\{ID\}/$BUFFERED_ID}"

  call "$method" "$control_path"  "control-$label"  "$data"
  call "$method" "$buffered_path" "buffered-$label" "$data"

  local control_status=$(cat "$WORK/control-$label.status")
  local buffered_status=$(cat "$WORK/buffered-$label.status")

  local verdict colour
  if [[ "$buffered_status" =~ ^5 ]]; then
    verdict="FAIL (5xx on buffered)"; colour=$c_fail
    failures+=( "$label  buffered 5xx  status=$buffered_status" )
    fail_count=$((fail_count + 1))
  elif [[ "$control_status" == "$buffered_status" ]]; then
    verdict="parity"; colour=$c_ok
    pass_count=$((pass_count + 1))
  else
    verdict="DIVERGED"; colour=$c_fail
    failures+=( "$label  control=$control_status  buffered=$buffered_status" )
    fail_count=$((fail_count + 1))
  fi

  printf "%s[%-26s]%s %-6s control=%-3s buffered=%-3s  %s%-22s%s\n" \
    "$c_dim" "$label" "$c_reset" \
    "$method" "$control_status" "$buffered_status" \
    "$colour" "$verdict" "$c_reset"
  printf "%s     control:  %s%s\n"  "$c_dim" "$(body_preview "$WORK/control-$label.body")"  "$c_reset"
  printf "%s     buffered: %s%s\n"  "$c_dim" "$(body_preview "$WORK/buffered-$label.body")" "$c_reset"
}

# ----------------------------------------------------------------------
# 1. Set up CONTROL run — delayed trigger so it lives in PG, never executes
# ----------------------------------------------------------------------

echo "${c_dim}==> Setting up control run (delay=$CONTROL_DELAY so worker never picks it up)${c_reset}"
call POST "/api/v1/tasks/$TASK_ID/trigger" "control-trigger" \
  "{\"payload\":{\"message\":\"control\"},\"options\":{\"delay\":\"$CONTROL_DELAY\"}}"

CONTROL_TRIGGER_STATUS=$(cat "$WORK/control-trigger.status")
if [[ "$CONTROL_TRIGGER_STATUS" != "200" && "$CONTROL_TRIGGER_STATUS" != "201" ]]; then
  echo "${c_fail}    FAIL: control trigger returned $CONTROL_TRIGGER_STATUS${c_reset}"
  echo "${c_fail}    body: $(body_preview "$WORK/control-trigger.body")${c_reset}"
  exit 1
fi

CONTROL_ID=$(jq -r '.id' "$WORK/control-trigger.body")
echo "    control runId  = $CONTROL_ID  (in PG, DELAYED)"

# ----------------------------------------------------------------------
# 2. Set up BUFFERED run — parallel burst, capture one mollified id
# ----------------------------------------------------------------------

echo
echo "${c_dim}==> Firing ${BURST_SIZE}-trigger burst to get a mollified run${c_reset}"

BURST_DIR=$WORK/burst
mkdir -p "$BURST_DIR"
for i in $(seq 1 "$BURST_SIZE"); do
  curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"message\":\"burst-$i\"}}" \
    "$API_BASE/api/v1/tasks/$TASK_ID/trigger" \
    -o "$BURST_DIR/$i.json" &
done
wait

BUFFERED_ID=""
for f in "$BURST_DIR"/*.json; do
  if jq -e '.notice.code == "mollifier.queued"' "$f" >/dev/null 2>&1; then
    BUFFERED_ID=$(jq -r '.id' "$f")
    break
  fi
done

if [[ -z "$BUFFERED_ID" ]]; then
  echo "${c_fail}    FAIL: no mollifier.queued response in $BURST_SIZE-trigger burst.${c_reset}"
  echo "${c_fail}    Check: mollifier enabled, threshold low enough, drainer paused.${c_reset}"
  exit 1
fi
echo "    buffered runId = $BUFFERED_ID  (in Redis only)"

if command -v docker >/dev/null 2>&1 \
   && docker ps --format '{{.Names}}' | grep -q '^redis$' \
   && [[ -n "${ENV_ID:-}" ]]; then
  echo "    redis LLEN     = $(docker exec -i redis redis-cli llen "mollifier:queue:$ENV_ID")"
fi

# ----------------------------------------------------------------------
# 3. Probe every runId-shaped endpoint against BOTH runs
# ----------------------------------------------------------------------

echo
echo "${c_dim}==> Probing endpoints — control vs buffered should match${c_reset}"
echo

probe_compare "retrieve-v3"  GET  "/api/v3/runs/{ID}"
probe_compare "trace"        GET  "/api/v1/runs/{ID}/trace"
probe_compare "events"       GET  "/api/v1/runs/{ID}/events"
probe_compare "attempts"     GET  "/api/v1/runs/{ID}/attempts"
probe_compare "result"       GET  "/api/v1/runs/{ID}/result"
probe_compare "metadata-get" GET  "/api/v1/runs/{ID}/metadata"
probe_compare "metadata-put" PUT  "/api/v1/runs/{ID}/metadata" '{"metadata":{"probe":"true"}}'
probe_compare "tags-add"     POST "/api/v1/runs/{ID}/tags"     '{"tags":["parity"]}'
probe_compare "replay"       POST "/api/v1/runs/{ID}/replay"   '{}'
probe_compare "reschedule"   POST "/api/v1/runs/{ID}/reschedule" '{"delay":"5m"}'
probe_compare "cancel-v2"    POST "/api/v2/runs/{ID}/cancel"   '{}'

# ----------------------------------------------------------------------
# 4. Summary
# ----------------------------------------------------------------------

echo
echo "${c_dim}==> Summary${c_reset}"
echo "    parity: $pass_count"
if (( fail_count > 0 )); then
  echo "    ${c_fail}drift:  $fail_count${c_reset}"
  for f in "${failures[@]}"; do
    echo "      ${c_fail}- $f${c_reset}"
  done
  echo
  echo "    ${c_dim}Each drift is an endpoint where a customer SDK call would see"
  echo "    a different response depending on whether the run is in PG or in"
  echo "    the mollifier buffer. The buffered path needs either a Redis"
  echo "    fallback or an explicit \"buffered, try again shortly\" 4xx.${c_reset}"
  exit 1
else
  echo "    ${c_ok}all probed endpoints behave identically against a buffered run.${c_reset}"
fi
