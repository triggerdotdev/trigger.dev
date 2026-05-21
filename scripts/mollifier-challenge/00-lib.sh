#!/usr/bin/env bash
# Shared helpers for the mollifier challenge suite. Source this from each
# scenario script: `source "$(dirname "$0")/00-lib.sh"`.

set -uo pipefail

: "${API_BASE:=http://localhost:3030}"
: "${TASK_ID:=hello-world}"
: "${BURST_SIZE:=30}"
: "${VERBOSE:=0}"

if [[ -z "${API_KEY:-}" ]]; then
  echo "ERROR: API_KEY env var is required" >&2
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required" >&2
  exit 2
fi

if [[ -t 1 ]]; then
  C_OK=$'\033[32m'; C_FAIL=$'\033[31m'; C_WARN=$'\033[33m'
  C_DIM=$'\033[2m'; C_BOLD=$'\033[1m'; C_RESET=$'\033[0m'
else
  C_OK=; C_FAIL=; C_WARN=; C_DIM=; C_BOLD=; C_RESET=
fi

# Per-script work directory, auto-cleaned on exit.
WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT

# pass_count + fail_count accumulators. Use `pass`, `fail`, and `summary`.
PASS_COUNT=0
FAIL_COUNT=0
declare -a FAILURES=()

pass() {
  printf "  %s✓%s %s\n" "$C_OK" "$C_RESET" "$1"
  PASS_COUNT=$((PASS_COUNT + 1))
}

fail() {
  printf "  %s✗%s %s\n" "$C_FAIL" "$C_RESET" "$1"
  FAILURES+=( "$1" )
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

info() {
  printf "  %s%s%s\n" "$C_DIM" "$1" "$C_RESET"
}

header() {
  printf "\n%s==>%s %s%s%s\n" "$C_DIM" "$C_RESET" "$C_BOLD" "$1" "$C_RESET"
}

summary() {
  printf "\n%s==>%s Summary\n" "$C_DIM" "$C_RESET"
  printf "  passed: %d\n" "$PASS_COUNT"
  if (( FAIL_COUNT > 0 )); then
    printf "  %sfailed: %d%s\n" "$C_FAIL" "$FAIL_COUNT" "$C_RESET"
    for f in "${FAILURES[@]}"; do
      printf "    %s- %s%s\n" "$C_FAIL" "$f" "$C_RESET"
    done
    exit 1
  fi
  printf "  %sall scenarios pass%s\n" "$C_OK" "$C_RESET"
  exit 0
}

# api METHOD PATH [DATA] → echoes "STATUS BODY"
# Stores body in $WORK/last.body, status in $WORK/last.status.
api() {
  local method=$1 path=$2 data=${3:-}
  local body_file=$WORK/last.body
  local status_file=$WORK/last.status
  local args=( -s -o "$body_file" -w "%{http_code}" -X "$method"
    -H "Authorization: Bearer $API_KEY" )
  if [[ -n "$data" ]]; then
    args+=( -H "Content-Type: application/json" -d "$data" )
  fi
  args+=( "$API_BASE$path" )
  local status
  status=$(curl "${args[@]}")
  echo "$status" > "$status_file"
  if [[ "$VERBOSE" == "1" ]]; then
    info "$method $path → $status"
    info "  $(head -c 200 "$body_file")"
  fi
  printf "%s" "$status"
}

# Returns 0 if last status is 2xx.
last_status_ok() {
  [[ "$(cat "$WORK/last.status" 2>/dev/null)" =~ ^2 ]]
}

# Read last body or empty.
last_body() {
  cat "$WORK/last.body" 2>/dev/null || echo ""
}

# Returns 0 if the body matches a jq filter.
body_matches() {
  local filter=$1
  jq -e "$filter" "$WORK/last.body" >/dev/null 2>&1
}

# Trigger a burst, return one buffered runId on stdout (or empty if none).
# Side effect: also writes burst responses to $WORK/burst/.
capture_buffered_run_id() {
  local task=${1:-$TASK_ID}
  local size=${2:-$BURST_SIZE}
  local payload=${3:-'{"message":"burst"}'}
  local burst_dir=$WORK/burst
  mkdir -p "$burst_dir"
  for i in $(seq 1 "$size"); do
    curl -s -X POST \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "{\"payload\":$payload}" \
      "$API_BASE/api/v1/tasks/$task/trigger" \
      -o "$burst_dir/$i.json" &
  done
  wait
  for f in "$burst_dir"/*.json; do
    if jq -e '.notice.code == "mollifier.queued"' "$f" >/dev/null 2>&1; then
      jq -r '.id' "$f"
      return 0
    fi
  done
}
