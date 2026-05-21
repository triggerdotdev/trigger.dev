#!/usr/bin/env bash
# 14 — dashboard mutation routes (D1, D2, D3) handle buffered runs.
# These use session-cookie auth, not bearer tokens. Provide the session
# cookie via SESSION_COOKIE env var (the value of the `__session` cookie
# from a logged-in browser; can be obtained via Playwright MCP).
#
# Required:
#   - drainer OFF
#   - SESSION_COOKIE env var (value of __session cookie)
#   - ORG_SLUG, PROJECT_SLUG, ENV_SLUG env vars matching the seeded data
#
# Dashboard routes tested:
#   D1: POST /resources/taskruns/{runParam}/cancel
#   D2: POST /resources/taskruns/{runParam}/replay  (just verifies action accepts; redirect target is org/project-scoped)
#   D3: POST /resources/orgs/{org}/projects/{proj}/env/{env}/runs/{run}/idempotencyKey/reset

source "$(dirname "$0")/00-lib.sh"

if [[ -z "${SESSION_COOKIE:-}" ]]; then
  fail "SESSION_COOKIE env var is required (value of the __session cookie)"
  info "Obtain it via Playwright: navigate to /login, complete the email magic link with local@trigger.dev, then read document.cookie."
  summary
fi
: "${ORG_SLUG:?ORG_SLUG env var required}"
: "${PROJECT_SLUG:?PROJECT_SLUG env var required}"
: "${ENV_SLUG:?ENV_SLUG env var required}"

# Dashboard request helper: uses session cookie + CSRF if needed.
dash() {
  local method=$1 path=$2 form_data=${3:-}
  local body_file=$WORK/last.body status_file=$WORK/last.status
  local args=( -s -o "$body_file" -w "%{http_code}" -X "$method"
    -H "Cookie: __session=$SESSION_COOKIE"
    -H "Referer: $API_BASE/" )
  if [[ -n "$form_data" ]]; then
    args+=( -H "Content-Type: application/x-www-form-urlencoded" -d "$form_data" )
  fi
  args+=( "$API_BASE$path" )
  local status
  status=$(curl "${args[@]}")
  echo "$status" > "$status_file"
  if [[ "$VERBOSE" == "1" ]]; then
    info "$method $path → $status"
    info "  $(head -c 200 "$body_file")"
  fi
}

# Helper: produce a buffered run with a known idempotency key.
KEY="dash-$(date +%s)-$RANDOM"
BURST_DIR=$WORK/burst
mkdir -p "$BURST_DIR"
for i in $(seq 1 "$BURST_SIZE"); do
  curl -s -X POST \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d "{\"payload\":{\"i\":$i},\"options\":{\"idempotencyKey\":\"$KEY\"}}" \
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
  fail "no buffered run — gate not tripping"
  summary
fi
info "buffered runId=$BUFFERED_ID, key=$KEY"

# --- D3: idempotencyKey reset (cookie-auth) ----------------------------
header "D3: dashboard idempotencyKey reset on a buffered run"
dash POST "/resources/orgs/$ORG_SLUG/projects/$PROJECT_SLUG/env/$ENV_SLUG/runs/$BUFFERED_ID/idempotencyKey/reset" ""
status=$(cat "$WORK/last.status")
if [[ "$status" =~ ^2 ]]; then
  pass "dashboard reset returned 2xx"
else
  fail "dashboard reset status=$status body=$(last_body | head -c 200)"
fi

# Confirm via API: retriggering with the key should produce a fresh run.
api POST "/api/v1/tasks/$TASK_ID/trigger" \
  "{\"payload\":{\"post-dash-reset\":true},\"options\":{\"idempotencyKey\":\"$KEY\"}}"
NEW_ID=$(last_body | jq -r '.id')
if [[ "$NEW_ID" != "$BUFFERED_ID" ]]; then
  pass "post-dashboard-reset trigger created NEW runId=$NEW_ID"
else
  fail "post-dashboard-reset trigger returned original runId — reset didn't clear"
fi

# --- D2: replay (cookie-auth, form data) -------------------------------
# Re-buffer for the replay probe.
BUFFERED_ID_2=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID_2" ]]; then
  fail "could not buffer a second run for replay probe"
  summary
fi

header "D2: dashboard replay on a buffered run"
dash POST "/resources/taskruns/$BUFFERED_ID_2/replay" \
  "failedRedirect=$API_BASE/&environment=&"
status=$(cat "$WORK/last.status")
# Dashboard mutations typically redirect (302) on success.
if [[ "$status" =~ ^(2|3) ]]; then
  pass "dashboard replay returned $status (2xx/redirect)"
else
  fail "dashboard replay status=$status body=$(last_body | head -c 200)"
fi

# --- D1: cancel (cookie-auth, form data) -------------------------------
BUFFERED_ID_3=$(capture_buffered_run_id)
if [[ -z "$BUFFERED_ID_3" ]]; then
  fail "could not buffer a third run for cancel probe"
  summary
fi

header "D1: dashboard cancel on a buffered run"
dash POST "/resources/taskruns/$BUFFERED_ID_3/cancel" \
  "redirectUrl=$API_BASE/"
status=$(cat "$WORK/last.status")
if [[ "$status" =~ ^(2|3) ]]; then
  pass "dashboard cancel returned $status"
else
  fail "dashboard cancel status=$status body=$(last_body | head -c 200)"
fi

summary
