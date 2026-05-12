# REVIEW.md — Trigger.dev OSS

Repo-specific signal for anyone (human or agent) reviewing a PR in this codebase. Calibrates what counts as critical, what to always check, and what to skip.

## What makes a 🔴 Important finding here

Reserve 🔴 for things that would page someone or block a rollback. In this codebase, that means:

- **Rolling-deploy breakage.** Old and new versions of the webapp/supervisor run side-by-side during deploys. A change is broken if:
  - A Lua script's behavior changes for a given key set without versioning (rename the script with a behavior-descriptive suffix like `Tracked` rather than `V2` — both versions must coexist safely).
  - A Redis data shape used by both versions changes in place. New shapes need a new key namespace.
  - A migration is not backward-compatible with the prior image.
- **Schema / migration safety.** Prisma migrations must be backward-compatible with the prior deploy. Adding NOT NULL without a default, dropping a column an old image still reads, renaming a column — all 🔴.
- **Queue / concurrency correctness.** RunQueue, MarQS (V1, legacy), redis-worker — any change to enqueue / dequeue / locking semantics. Re-derive the invariant on paper before flagging or accepting.
- **Missing index on a hot table.** New Prisma queries against `TaskRun`, `TaskRunExecutionSnapshot`, `JobRun`, `Project`, etc. must use an existing index. Check `internal-packages/database/prisma/schema.prisma` for the relevant `@@index` lines — don't guess and don't propose `EXPLAIN`.
- **Recovery-path queries.** Any `TaskRun.findFirst` / `findMany` added to a schedule, run-recovery, or restart loop. Recovery fan-outs (Redis crash, restart storms) turn "rare indexed query" into a DB incident. 🔴 even if indexed.
- **Aggregations on hot tables.** No `COUNT` / `GROUP BY` on `TaskRun` or other multi-million-row tables. Use Redis or ClickHouse for counts.
- **Prod Redis blast-radius.** New code paths that `SCAN` with broad patterns (`*foo*`) on prod-shaped Redis, or `EVAL` Lua with `SCAN` loops inside. Both are 🔴.
- **`@trigger.dev/core` direct import** from anywhere outside the SDK package. Always import from `@trigger.dev/sdk`. Core direct imports are 🔴 — they break the public API contract.
- **Heavy execute-deps imported into request-handler bundles.** Specifically `chat.handover` and similar split-bundle entry points must not transitively import the agent task's execute path. Watch for new imports added at module top-level of route files.
- **V1 engine code modified in a "V2 only" PR.** The `apps/webapp/app/v3/` directory contains both. If the PR description says V2-only but it touches `triggerTaskV1`, `cancelTaskRunV1`, `MarQS`, etc. — 🔴.

## Always check

- **Tests use testcontainers, not mocks.** Vitest with `redisTest` / `postgresTest` / `containerTest` from `@internal/testcontainers`. Any new `vi.mock(...)` on Redis, Postgres, BullMQ, or other infra is wrong here — 🔴 if added in production-path tests, 🟡 if isolated unit test.
- **Public-package changes have a changeset.** `pnpm run changeset:add` produces `.changeset/*.md`. Required for any edit under `packages/*`. Missing → 🟡; missing on a breaking change → 🔴.
- **Server-only changes have `.server-changes/*.md`.** Required for `apps/webapp/`, `apps/supervisor/` edits with no public-package change. Body should be 1-2 sentences (it has to fit as one bullet in a future changelog). Missing → 🟡.
- **Lua script naming.** Coexisting scripts use behavior-descriptive suffixes (`Tracked`), never `V2`. Old name must keep working until the next deploy clears it.
- **RunQueue payload shape.** V2 run-queue payload's `projectId` is consumed by `workerQueueResolver` for override matching. If a PR drops it from the payload, 🔴.
- **`safeSend` scope.** Defensive IPC wrappers belong on loop / interval / handler contexts, not one-shot terminal sends. If the PR adds `safeSend` to a single terminal call for consistency, 🟡 with a "remove this" suggestion.
- **Zod version.** Pinned to `3.25.76` monorepo-wide. New package adding zod with a different version or range — 🔴.

## Skip (do NOT flag)

- Anything Prettier / ESLint catches. CI runs both.
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
