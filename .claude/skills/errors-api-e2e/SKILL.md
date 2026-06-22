---
name: errors-api-e2e
description: End-to-end smoke test for the public Errors HTTP API (error groups). Seeds failed runs into ClickHouse so the error materialized views populate, then drives the real endpoints against the running webapp — list (with filters + pagination), retrieve, resolve/ignore/unresolve, the `filter[error]` runs filter, user attribution via the `trigger.dev mint-token` -> JWT exchange, and the 401/403/404 negatives. Use for "smoke test the errors API", "test the errors API e2e", "prove the errors endpoints work", or to re-verify after changes.
allowed-tools: Read, Bash
---

# Errors API — end-to-end smoke test

Proves the public Errors API against the **running** webapp with real HTTP. No
mocks. The error data plane is ClickHouse (`errors_v1` + `error_occurrences_v1`,
both materialized-view-fed from `task_runs_v2`) plus Postgres `ErrorGroupState`
for lifecycle status; this skill seeds straight into `task_runs_v2` and lets the
MVs do the rest.

Code under test:
- `apps/webapp/app/routes/api.v1.errors.ts` — `GET /api/v1/errors` (list).
- `apps/webapp/app/routes/api.v1.errors.$errorId.ts` — `GET /api/v1/errors/:errorId` (detail).
- `apps/webapp/app/routes/api.v1.errors.$errorId.{resolve,ignore,unresolve}.ts` — state actions.
- `apps/webapp/app/presenters/v3/ApiErrorListPresenter.server.ts` / `ApiErrorGroupPresenter.server.ts`.
- `apps/webapp/app/presenters/v3/ApiRunListPresenter.server.ts` — the `filter[error]` addition on `GET /api/v1/runs`.
- `apps/webapp/app/v3/services/errorGroupActions.server.ts` — resolve/ignore/unresolve (nullable `userId`).
- Attribution: `api.v1.projects.$projectRef.$env.jwt.ts` stamps `act:{sub}` for PAT **and** UAT exchanges; `@trigger.dev/rbac` surfaces `act.sub` through bearer auth; the action handlers read `authentication.actor?.sub`.

`errorId` is `error_<fingerprint>` (round-trips via `ErrorId` in `@trigger.dev/core/v3/isomorphic`).

## Prerequisites

- Webapp running on http://localhost:3030 (`pnpm run dev --filter webapp`). Confirm `curl -s http://localhost:3030/healthcheck`.
- DB seeded (`pnpm run db:seed`), and a local ClickHouse reachable at `CLICKHOUSE_URL` (the `pnpm run docker` stack).
- The CLI built + logged in to localhost:3030 (`pnpm run build --filter trigger.dev`; profile `default` points at localhost:3030). Needed only for the attribution leg.

> Important wiring facts the seed relies on (verified):
> - The MVs read the error type/message from `error.data.*`, so the seeded
>   `error` JSON column **must** be wrapped: `{"data": {"type": ..., "message": ..., "stack": ...}}`.
> - The MVs only fire for failed statuses: `SYSTEM_FAILURE | CRASHED | INTERRUPTED | COMPLETED_WITH_ERRORS | TIMED_OUT`, and require a non-empty `error_fingerprint`.
> - `GET /api/v1/runs` lists run **ids** from ClickHouse but **hydrates from Postgres** `TaskRun`. So the error-list/detail/action legs work from a ClickHouse-only seed, but the `filter[error]` leg needs a **paired** Postgres `TaskRun` row whose `id` equals the ClickHouse `run_id`.

Run everything from the repo root in one shell. Invoke the built CLI via a
function (a `CLI="node …"` variable won't word-split under zsh):
```bash
cli() { node packages/cli-v3/dist/esm/index.js "$@"; }
PROFILE=default
```

## Setup — resolve a dev environment + connection strings

```bash
cd apps/webapp
CHURL=$(grep -E "^CLICKHOUSE_URL=" .env | head -1 | cut -d= -f2- | tr -d '"')
DBURL=$(grep -E "^DATABASE_URL=" .env | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" | sed 's/?.*//')

# Pick the seeded hello-world dev env (proj_rrkpdguyagvsoktglnod). Adjust the
# WHERE if you want a different project.
read ENV ORG PROJ REF < <(psql "$DBURL" -t -A -F' ' -c "
  SELECT re.id, re.\"organizationId\", re.\"projectId\", p.\"externalRef\"
  FROM \"RuntimeEnvironment\" re
  JOIN \"Project\" p ON p.id = re.\"projectId\"
  WHERE re.slug='dev' AND p.\"externalRef\"='proj_rrkpdguyagvsoktglnod' LIMIT 1;")
APIKEY=$(psql "$DBURL" -t -A -c "SELECT \"apiKey\" FROM \"RuntimeEnvironment\" WHERE id='$ENV';")
cd ..
H="Authorization: Bearer $APIKEY"
B="http://localhost:3030"
```

## Steps

### 1. Seed two error groups (ClickHouse, MV-fed)

```bash
RUN=$(node -e 'console.log(Date.now().toString(36))')
TASK="errors-api-e2e-$RUN"; FP_A="fpA${RUN}"; FP_B="fpB${RUN}"
ERRID_A="error_$FP_A"; ERRID_B="error_$FP_B"
NOW_CH=$(node -e 'console.log(new Date().toISOString().replace("T"," ").replace("Z","").slice(0,23))')
NOW_MS=$(node -e 'console.log(Date.now())')
Q=$(python3 -c "import urllib.parse;print(urllib.parse.quote('INSERT INTO trigger_dev.task_runs_v2 FORMAT JSONEachRow'))")

mkrow() { # status fingerprint errorType message runId
  echo "{\"environment_id\":\"$ENV\",\"organization_id\":\"$ORG\",\"project_id\":\"$PROJ\",\"run_id\":\"$5\",\"friendly_id\":\"run_$5\",\"status\":\"$1\",\"environment_type\":\"DEVELOPMENT\",\"engine\":\"V2\",\"task_identifier\":\"$TASK\",\"created_at\":\"$NOW_CH\",\"updated_at\":\"$NOW_CH\",\"error\":{\"data\":{\"type\":\"$3\",\"message\":\"$4\",\"stack\":\"at x (a.ts:1:1)\"}},\"error_fingerprint\":\"$2\",\"task_version\":\"20240101.1\",\"_version\":\"$NOW_MS\",\"_is_deleted\":0}"
}
ROWS="$(mkrow COMPLETED_WITH_ERRORS $FP_A AlphaBoom 'alpha boom happened' r_a1_$RUN)
$(mkrow COMPLETED_WITH_ERRORS $FP_A AlphaBoom 'alpha boom happened' r_a2_$RUN)
$(mkrow CRASHED $FP_B BetaCrash 'beta crash happened' r_b1_$RUN)"
printf '%s' "$ROWS" | curl -s "$CHURL/?query=$Q" --data-binary @-

# Poll until both fingerprints appear in errors_v1 (the MV is near-instant locally).
for i in $(seq 1 10); do
  N=$(curl -s "$CHURL" --data-binary "SELECT count() FROM (SELECT 1 FROM trigger_dev.errors_v1 WHERE environment_id='$ENV' AND error_fingerprint IN ('$FP_A','$FP_B') GROUP BY error_fingerprint)")
  [ "$N" = "2" ] && break; sleep 1
done
echo "seeded fingerprints in errors_v1: $N (want 2)"
```
PASS: `N = 2`. Alpha has 2 occurrences, beta 1.

### 2. List + filters + pagination

```bash
curl -s "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK&filter%5Bperiod%5D=1d" -H "$H" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print('count',len(d['data']),[(e['id'],e['status'],e['count']) for e in d['data']])"
```
PASS: 2 groups, both `status=unresolved`, alpha `count=2`, beta `count=1`, ids `error_<fp>`.

Assert each filter narrows correctly (each should return the noted shape):
```bash
curl -s "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK&filter%5Bstatus%5D=unresolved&filter%5Bperiod%5D=1d" -H "$H" | python3 -c "import sys,json;print('unresolved:',len(json.load(sys.stdin)['data']))"   # 2
curl -s "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK&filter%5Bsearch%5D=AlphaBoom&filter%5Bperiod%5D=1d" -H "$H" | python3 -c "import sys,json;print('search:',[e['errorType'] for e in json.load(sys.stdin)['data']])"   # ['AlphaBoom']
curl -s "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK&filter%5Bperiod%5D=1d&page%5Bsize%5D=1" -H "$H" | python3 -c "import sys,json;d=json.load(sys.stdin);print('page size 1:',len(d['data']),'next?',bool(d['pagination'].get('next')))"   # 1 / True
```
PASS: `unresolved: 2`, `search: ['AlphaBoom']`, `page size 1: 1 / next? True`.

### 3. Retrieve detail

```bash
curl -s "$B/api/v1/errors/$ERRID_A" -H "$H" \
  | python3 -c "import sys,json;d=json.load(sys.stdin);print(d['id'],d['errorType'],d['status'],d['count'],d['affectedVersions'],d['resolvedBy'])"
```
PASS: `error_<fpA> AlphaBoom unresolved 2 ['20240101.1'] None`.

### 4. Resolve / ignore / unresolve (env API key — `resolvedBy` null)

```bash
st(){ python3 -c "import sys,json;d=json.load(sys.stdin);print('status',d['status'],'| resolvedInVersion',d['resolvedInVersion'],'| resolvedBy',d['resolvedBy'],'| ignoredUntil',bool(d['ignoredUntil']),'| reason',d['ignoredReason'])"; }

curl -s -X POST "$B/api/v1/errors/$ERRID_A/resolve" -H "$H" -H 'Content-Type: application/json' -d '{"resolvedInVersion":"20240101.1"}' >/dev/null
curl -s "$B/api/v1/errors/$ERRID_A" -H "$H" | st   # status resolved | resolvedInVersion 20240101.1 | resolvedBy None

curl -s -X POST "$B/api/v1/errors/$ERRID_B/ignore" -H "$H" -H 'Content-Type: application/json' -d '{"duration":3600000,"reason":"known flake"}' >/dev/null
curl -s "$B/api/v1/errors/$ERRID_B" -H "$H" | st   # status ignored | ignoredUntil True | reason known flake

curl -s -X POST "$B/api/v1/errors/$ERRID_A/unresolve" -H "$H" >/dev/null
curl -s "$B/api/v1/errors/$ERRID_A" -H "$H" | st   # status unresolved
```
PASS: each transition reflected; `filter[status]=ignored` returns only beta:
```bash
curl -s "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK&filter%5Bstatus%5D=ignored&filter%5Bperiod%5D=1d" -H "$H" | python3 -c "import sys,json;print([e['id'] for e in json.load(sys.stdin)['data']])"   # [error_<fpB>]
```

### 5. `filter[error]` on the runs list (paired PG + CH seed)

The runs list hydrates from Postgres, so seed a matching `TaskRun` row + a CH row
that share `run_id`/`id` and carry a fingerprint:
```bash
RID="re2e${RUN}"; FRID="run_${RID}"; FP_R="fpR${RUN}"
psql "$DBURL" -v ON_ERROR_STOP=1 -c "
  INSERT INTO \"TaskRun\" (id, \"friendlyId\", \"taskIdentifier\", payload, \"traceId\", \"spanId\", \"runtimeEnvironmentId\", \"projectId\", queue, status, \"createdAt\", \"updatedAt\")
  VALUES ('$RID','$FRID','$TASK','{}','trace_$RID','span_$RID','$ENV','$PROJ','task/$TASK','COMPLETED_WITH_ERRORS', now(), now())
  ON CONFLICT (id) DO NOTHING;" >/dev/null
ROW="{\"environment_id\":\"$ENV\",\"organization_id\":\"$ORG\",\"project_id\":\"$PROJ\",\"run_id\":\"$RID\",\"friendly_id\":\"$FRID\",\"status\":\"COMPLETED_WITH_ERRORS\",\"environment_type\":\"DEVELOPMENT\",\"engine\":\"V2\",\"task_identifier\":\"$TASK\",\"created_at\":\"$NOW_CH\",\"updated_at\":\"$NOW_CH\",\"error\":{\"data\":{\"type\":\"RunsFilterErr\",\"message\":\"for runs filter\",\"stack\":\"at x\"}},\"error_fingerprint\":\"$FP_R\",\"task_version\":\"20240101.1\",\"_version\":\"$NOW_MS\",\"_is_deleted\":0}"
printf '%s' "$ROW" | curl -s "$CHURL/?query=$Q" --data-binary @-
sleep 1
curl -s "$B/api/v1/runs?filter%5Berror%5D=error_$FP_R" -H "$H" | python3 -c "import sys,json;d=json.load(sys.stdin);print('runs:',[r['id'] for r in d['data']])"
```
PASS: one run, `run_<RID>` (status maps to `FAILED`). Proves `filter[error]` -> fingerprint -> CH -> PG hydration.

### 6. Attribution — `mint-token` -> JWT exchange records the acting user

```bash
TOKEN=$(cli mint-token --profile $PROFILE --client errors-api-e2e 2>/dev/null)            # UAT
ENVJWT=$(curl -sS -X POST "$B/api/v1/projects/$REF/dev/jwt" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"claims":{"scopes":["read:errors","write:errors"]}}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
# Decoded env JWT carries act.sub = the user id.
node -e 'const p=JSON.parse(Buffer.from(process.argv[1].split(".")[1],"base64url").toString());console.log("act:",JSON.stringify(p.act))' "$ENVJWT"

curl -s -X POST "$B/api/v1/errors/$ERRID_A/resolve" -H "Authorization: Bearer $ENVJWT" \
  -H 'Content-Type: application/json' -d '{"resolvedInVersion":"20240101.2"}' >/dev/null
curl -s "$B/api/v1/errors/$ERRID_A" -H "$H" | python3 -c "import sys,json;d=json.load(sys.stdin);print('resolvedBy:',d['resolvedBy'])"
```
PASS: `act.sub` is the user id (matches `cli whoami`), and `detail.resolvedBy` equals that user id (not null). A plain env key leaves it null (step 4). A **PAT** exchanged the same way also stamps `act` — repeat with the stored PAT to confirm `ignoredByUserId` attribution.

### 7. Negatives

```bash
curl -s -o /dev/null -w 'unknown id: %{http_code} (404)\n'        "$B/api/v1/errors/error_doesnotexist0000" -H "$H"
curl -s -o /dev/null -w 'no auth list: %{http_code} (401)\n'      "$B/api/v1/errors"
curl -s -o /dev/null -w 'no auth resolve: %{http_code} (401)\n'   -X POST "$B/api/v1/errors/$ERRID_B/resolve" -H 'Content-Type: application/json' -d '{}'

# read-only JWT must be denied on write, allowed on read
READJWT=$(curl -sS -X POST "$B/api/v1/projects/$REF/dev/jwt" -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' -d '{"claims":{"scopes":["read:errors"]}}' | python3 -c "import sys,json;print(json.load(sys.stdin)['token'])")
curl -s -o /dev/null -w 'read JWT write: %{http_code} (403)\n'    -X POST "$B/api/v1/errors/$ERRID_B/resolve" -H "Authorization: Bearer $READJWT" -H 'Content-Type: application/json' -d '{}'
curl -s -o /dev/null -w 'read JWT read: %{http_code} (200)\n'     "$B/api/v1/errors?filter%5BtaskIdentifier%5D=$TASK" -H "Authorization: Bearer $READJWT"
```
PASS: `404`, `401`, `401`, `403`, `200` respectively.

## Result

Report PASS only if: step 1 lands 2 groups in `errors_v1`; step 2's filters and
pagination narrow correctly; step 3 returns the detail; step 4's resolve/ignore/
unresolve flip status (and `filter[status]` follows); step 5's `filter[error]`
returns the paired run; step 6 records `resolvedBy` = the acting user via the
JWT exchange (null with a plain env key); and step 7 returns 404/401/401/403/200.
A red leg is a bug or a missing prereq — report the exact status + body and file
a Linear issue, don't tune around it.

## Notes / gotchas

- Run files use a unique `$RUN` suffix per invocation, so reruns don't collide and seeded rows stay isolated by their unique task identifier. They are local-dev test rows (90-day ClickHouse TTL); no cleanup required.
- After **adding** the route files, the classic Remix dev compiler may not register them until a dev-server restart (a stale manifest returns Remix's HTML 404 on the new paths). If `POST …/resolve` returns a 404 HTML page rather than 401/200, restart `pnpm run dev --filter webapp`.
- The rbac `act` extraction lives in `@trigger.dev/rbac` (a built dep). After editing it, `pnpm run build --filter @trigger.dev/rbac` and restart the webapp so the attribution leg (step 6) reflects the change.
