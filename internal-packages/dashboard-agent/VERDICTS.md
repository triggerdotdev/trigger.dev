# Dashboard agent — M0 verdicts

Four questions settled before M1. Each cites the code it rests on, verified at HEAD.

## 1. Scope check: `get_report` works with the current UAT cap

The agent's delegated user-actor token is capped read-only, and the cap already
includes `read:query`:

- `apps/webapp/app/services/dashboardAgent.server.ts` — `DASHBOARD_AGENT_UAT_CAP`
  = `read:apiKeys`, `read:runs`, `read:deployments`, `read:environments`,
  `read:errors`, `read:query`.
- `apps/webapp/app/routes/api.v1.projects.$projectRef.$env.jwt.ts` — the env JWT's
  scopes are the requested set intersected with the token's cap (or the whole cap
  when nothing is requested), so `read:query` survives the exchange.

The reports route accepts that JWT:

- `apps/webapp/app/routes/api.v1.reports.$key.ts` — `allowJWT: true`, and
  `authorization.resource` is
  `everyResource(REPORT_QUERY_TABLES.map((id) => ({ type: "query", id })))`.
- `everyResource` requires `ability.can("read", …)` for every table
  (`apps/webapp/app/services/routeBuilders/apiBuilder.server.ts`), and an
  unqualified `read:query` scope matches any id of that type
  (`internal-packages/rbac/src/ability.test.ts`, `buildJwtAbility` cases).

**Verdict:** no cap change needed for `get_report`.

## 2. Per-run queue position: not available

Run-queue exposes aggregate depth only:

- `internal-packages/run-engine/src/run-queue/index.ts` — `lengthOfQueue`
  (`ZCARD` of the queue zset plus a CK length counter),
  `lengthOfQueueAvailableMessages` (`ZCOUNT`), `oldestMessageInQueue`.
- No `ZRANK` anywhere in `internal-packages/run-engine/src/run-queue/`.

Position is theoretically computable — the zset member is the runId — but only
within a single `(queue, concurrencyKey)` subqueue, and the ordering is not FIFO:

- Score is offset by priority:
  `internal-packages/run-engine/src/engine/systems/enqueueSystem.ts` (~line 104)
  computes `timestamp = queuePositionMs - run.priorityMs`.
- `queueTimestamp` can be back- or forward-dated, so scores don't track arrival.
- Concurrency-key sharding splits one logical queue across many zsets.
- Queue selection across queues is fair weighted-random shuffling, not ordered:
  `internal-packages/run-engine/src/run-queue/fairQueueSelectionStrategy.ts`.
- The enqueue fast path pushes straight to the worker queue and skips the zset
  entirely (`internal-packages/run-engine/src/run-queue/index.ts`, fast-path
  branch of `#callEnqueueMessage`).

ClickHouse aggregates have no run dimension either:
`internal-packages/clickhouse/schema/036_create_queue_metrics_v1.sql` sorts
`queue_metrics_v1` by `(organization_id, project_id, environment_id, queue_name,
bucket_start)` — no `run_id`.

**Verdict:** no per-run start ETA and no "you are Nth in line" in v1. Answers about
waiting runs state explicitly that a start estimate isn't available.

## 3. Environment identity: `RuntimeEnvironment.id`

- `(projectId, slug)` is **not** unique — the unique key is
  `@@unique([projectId, slug, orgMemberId])`
  (`internal-packages/database/prisma/schema.prisma`, `RuntimeEnvironment`),
  because every developer gets their own `dev` environment row.
- Preview branches are child environment rows (`parentEnvironmentId`) with their
  own ids.
- `@@unique([projectId, shortcode])` is DB-unique but lossy, slug-collision-prone,
  and not a public identifier.
- The `trigger://` URI's `{env}` segment is the RuntimeEnvironment id —
  `internal-packages/dashboard-agent-contracts/src/page-context.ts`.

Environment *names* (`dev` / `staging` / `prod` / `preview`) are display-only and
stay in the payload for back-compat with the agent's name-addressed tools.

Server-injected turn context now carries `environmentId` on both paths:

- `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$.ts`
  (turn N, the `in` proxy)
- `apps/webapp/app/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.ts`
  (turn 1, the head-start `create` path)

It is already accepted by `clientDataSchema`
(`internal-packages/dashboard-agent/src/dashboard-agent.ts`), and the
server-injected value wins over anything the browser sent.

**Verdict:** `RuntimeEnvironment.id` is the canonical environment identity.

## 4. Queue-wait timestamp: `queuedAt`

- `TaskRun.queuedAt` exists (`internal-packages/database/prisma/schema.prisma`).
  It is NULL for delayed runs until the delay fires —
  `internal-packages/run-engine/src/engine/systems/delayedRunSystem.ts` stamps it
  at that point.
- The canonical metric is `queued_duration = startedAt − queuedAt`, already public:
  `apps/webapp/app/v3/querySchemas.ts` (~line 294) —
  `dateDiff('millisecond', queued_at, started_at)`. Note the same file maps the
  public `dequeued_at` column to physical `started_at` (~line 222).
- When `queuedAt` is absent, `startedAt − createdAt` may be reported only as
  "time from creation to start" — never as queue or start latency.
- Re-enqueued runs (waitpoint / checkpoint resumes) keep a stale `queuedAt`, so
  their queue wait is not meaningful; flag or exclude them.

Known bug, **not** fixed in M0: `apps/webapp/app/presenters/v3/RunPresenter.server.ts`
(~line 366) computes `queuedDuration` as `startedAt − createdAt`, which
over-reports for delayed and scheduled runs.

**Verdict:** use `queuedAt` for anything labelled queue wait.
