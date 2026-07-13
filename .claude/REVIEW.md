# REVIEW.md — Trigger.dev OSS

Repo-specific signal for anyone (human or agent) reviewing a PR in this codebase. Calibrates what counts as critical, what to always check, and what to skip.

## What makes a 🔴 Important finding here

Reserve 🔴 for things that would page someone or block a rollback. In this codebase, that means:

- **Rolling-deploy breakage.** Old and new versions of the webapp/supervisor run side-by-side during deploys. A change is broken if:
  - A Lua script's behavior changes for a given key set without versioning (rename the script with a behavior-descriptive suffix like `Tracked` rather than `V2` — both versions must coexist safely).
  - A Redis data shape used by both versions changes in place. New shapes need a new key namespace.
  - A migration is not backward-compatible with the prior image.
- **Schema / migration safety.** Prisma migrations must be backward-compatible with the prior deploy. Adding NOT NULL without a default, dropping a column an old image still reads, renaming a column — all 🔴.
- **ClickHouse migration ordering + idempotency.** Goose runs in strict mode in the deploy pipeline and refuses to apply a missing version below the current version — slotting a new file in below the latest already-applied version blocks the deploy. New ClickHouse migration files MUST use the next available number (`max(files in internal-packages/clickhouse/schema/) + 1`); if main has added migrations while you've been on a branch, renumber yours. DDL must also be idempotent (`ADD COLUMN IF NOT EXISTS`, `DROP COLUMN IF EXISTS`, `CREATE TABLE IF NOT EXISTS`, `ADD INDEX IF NOT EXISTS`) so a partial / `--allow-missing` apply elsewhere doesn't fail on retry. Either fault is 🔴 — both break test/prod deploys. Rules live in `internal-packages/clickhouse/CLAUDE.md`.
- **Queue / concurrency correctness.** RunQueue, MarQS (V1, legacy), redis-worker — any change to enqueue / dequeue / locking semantics. Re-derive the invariant on paper before flagging or accepting.
- **Missing index on a hot table.** New Prisma queries against `TaskRun`, `TaskRunExecutionSnapshot`, `JobRun`, `Project`, etc. must use an existing index. Check `internal-packages/database/prisma/schema.prisma` for the relevant `@@index` lines — don't guess and don't propose `EXPLAIN`.
- **Recovery-path queries.** Any `TaskRun.findFirst` / `findMany` added to a schedule, run-recovery, or restart loop. Recovery fan-outs (Redis crash, restart storms) turn "rare indexed query" into a DB incident. 🔴 even if indexed.
- **Aggregations on hot tables.** No `COUNT` / `GROUP BY` on `TaskRun` or other tables that can reach billions of rows. Use Redis or ClickHouse for counts.
- **Prod Redis blast-radius.** New code paths that `SCAN` with broad patterns (`*foo*`) on prod-shaped Redis, or `EVAL` Lua with `SCAN` loops inside. Both are 🔴.
- **`@trigger.dev/core` direct import** from anywhere outside the SDK package. Always import from `@trigger.dev/sdk`. Core direct imports are 🔴 — they break the public API contract.
- **Heavy execute-deps imported into request-handler bundles.** Specifically `chat.handover` and similar split-bundle entry points must not transitively import the agent task's execute path. Watch for new imports added at module top-level of route files.
- **V1 engine code modified in a "V2 only" PR.** The `apps/webapp/app/v3/` directory contains both. If the PR description says V2-only but it touches `triggerTaskV1`, `cancelTaskRunV1`, `MarQS`, etc. — 🔴.

## Performance (always review)

Every PR gets a performance pass — not just the ones that look perf-sensitive. For each new query or unit of work, weigh three things: (a) the size of the table it hits, (b) whether it sits on a hot path, (c) whether the data it walks can be deep or wide (run trees, batches). The 🔴 bullets above on indexes, recovery-path queries, aggregations, and Redis `SCAN` are part of this pass — the rest below extends it.

**Treat these tables as large — no scans, no `COUNT` / `GROUP BY`, no unbounded fetch:**

- **Postgres — the `TaskRun` family:** `TaskRun`, `TaskRunExecutionSnapshot`, `Waitpoint`, `BatchTaskRun` and their join tables. Assume billions of rows.
- **ClickHouse — `task_events_v1` / `task_events_v2`.** Partitioned by `toDate(inserted_at)`; `ORDER BY (environment_id, toUnixTimestamp(start_time), trace_id)`. Note `span_id` / `parent_span_id` are NOT in the sort key — span-id lookups can't skip granules, only `environment_id` + a `start_time` window can.

**Hot paths — extra scrutiny on any added query or work:**

- **Trigger + batch trigger** (`triggerTask.server.ts`, `batchTriggerV3.server.ts`) — see `apps/webapp/CLAUDE.md`; do not add DB queries to these.
- **Dequeue / RunQueue** (`dequeueSystem.ts`, run-queue read/lock paths) — runs on every execution.
- **Execution-snapshot creation in the run engine** — any engine function that writes a `TaskRunExecutionSnapshot` runs per state transition; a new query there multiplies by run volume.
- **OTEL ingestion** (`otel.v1.traces.ts`, `otel.v1.logs.ts`) — write volume scales with customer span counts.
- **Trace + run-list reads** (trace view, run list, span detail) — read paths over the large tables above.

**Deep / wide shapes — one run can explode into a huge tree or batch; code that walks them is the trap:**

- Trace span subtrees (deeply nested child runs → deep span trees).
- Batch + parent/child fan-out (one run triggers thousands of children).
- Waitpoint / run-dependency chains.
- Tag / attribute many-to-many joins against the run/event tables.

**Anti-patterns (severity):**

- **Per-level fan-out that re-scans a large table once per tree depth** → 🔴. A BFS issuing one query per level (e.g. `parent_span_id IN {thisLevel}`) re-reads the same granules D times for a depth-D tree. Prefer one windowed query + an in-memory tree build.
- **Dropping the partition-pruning predicate** — `inserted_at` for ClickHouse, the `createdAt` window for partitioned Postgres — to "widen" a lookup → 🔴. Without it the query scans every partition. Keep a bounded window even for ancestor / backfill lookups.
- **Unbounded `IN (...)` built from a result set** (a BFS frontier, a batch's child ids) → 🟡. It can reach the row cap (`MAXIMUM_TRACE_SUMMARY_VIEW_COUNT` defaults to 25k). Cap or chunk to ≤1–2k ids per query.
- **Sequential per-level round-trips** where one recursive or windowed query would do → 🟡. N levels = N round-trip latencies stacked.
- **Replacing a single bounded query with a multi-query walk for _every_ call** (not just a rare fallback) → 🔴 on a hot read path, 🟡 elsewhere. Keep the cheap single-query path; branch into the expensive walk only when the cheap one comes up short.

## Always check

- **Tests use testcontainers, not mocks.** Vitest with `redisTest` / `postgresTest` / `containerTest` from `@internal/testcontainers`. Any new `vi.mock(...)` on Redis, Postgres, BullMQ, or other infra is wrong here — 🔴 if added in production-path tests, 🟡 if isolated unit test.
- **Public-package changes have a changeset.** `pnpm run changeset:add` produces `.changeset/*.md`. Required for any edit under `packages/*`. Missing → 🟡; missing on a breaking change → 🔴.
- **Server-only changes have `.server-changes/*.md`.** Required for `apps/webapp/`, `apps/supervisor/` edits with no public-package change. Body should be 1-2 sentences (it has to fit as one bullet in a future changelog). Missing → 🟡.
- **Lua script naming.** Coexisting scripts use behavior-descriptive suffixes (`Tracked`), never `V2`. Old name must keep working until the next deploy clears it.
- **RunQueue payload shape.** V2 run-queue payload's `projectId` is consumed by `workerQueueResolver` for override matching. If a PR drops it from the payload, 🔴.
- **`safeSend` scope.** Defensive IPC wrappers belong on loop / interval / handler contexts, not one-shot terminal sends. If the PR adds `safeSend` to a single terminal call for consistency, 🟡 with a "remove this" suggestion.
- **Zod version.** Pinned to `3.25.76` monorepo-wide. New package adding zod with a different version or range — 🔴.

## Skip (do NOT flag)

- Anything oxfmt / oxlint catches. CI enforces both via the `code-quality` check.
- TypeScript style preferences (`type` vs `interface`) — already covered by repo standards.
- Test coverage exhortations as a generic suggestion. Only flag missing tests when a specific code path is genuinely untested and the path has prior incidents.
- `agentcrumbs` markers (`// @crumbs`, `// #region @crumbs`) and `agentcrumbs` imports — these are temporary debug instrumentation stripped before merge.
- `// removed comments for removed code`, renamed `_unused` vars, re-exported types as "backwards compatibility shims" — also covered by repo standards.
- Suggestions to "add error handling" without naming a specific scenario that breaks.
- Documentation prose nitpicks in `docs/*` MDX files unless factually wrong.

## Things V1/legacy that should NOT block a PR

The `apps/webapp/app/v3/` directory name is misleading — most code there is V2. Only specific files are V1-only legacy: `MarQS` queue, `triggerTaskV1`, `cancelTaskRunV1`, and a handful of others (see `apps/webapp/CLAUDE.md` for the exact list). Don't flag "you should refactor this to use V2" on those — they're frozen.

## Confidence calibration for this repo

The most common false-positive pattern: speculating about race conditions in code paths the agent doesn't have runtime visibility into. If the only evidence is "this *could* race", drop it. If you can point to a specific interleaving with file:line for each step, surface it.
