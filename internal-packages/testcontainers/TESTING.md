# Fast local testing loop

These tests use real Docker containers (Postgres, ClickHouse, Redis, Electric, MinIO) via testcontainers - never mocks. This guide is the fast inner loop for working on them.

## Prerequisites

- **Docker daemon running.** That's it - testcontainers boots its own containers. You do **not** need `pnpm run docker` (that compose stack is for running the app, and is separate).

## The loop

```bash
# 1. Build upstream deps once (turbo-caches them; only re-runs when a dep changes)
pnpm run build --filter @internal/run-engine

# 2. Iterate by running vitest DIRECTLY in the package - not via `turbo run test`
cd internal-packages/run-engine
pnpm exec vitest run src/engine/tests/ttl.test.ts        # one file
pnpm exec vitest src/engine/tests/ttl.test.ts            # watch mode, tightest loop
pnpm exec vitest run src/engine/tests/ --reporter=verbose # per-test timings
```

> **Why run vitest directly, not `turbo run test`?** The `test` turbo task is cacheable
> (`outputs: []`). A second `turbo run test` with no input change replays the cached
> result in ~0ms instead of executing - useless when you're measuring timing. Run vitest
> directly (or `turbo run test --force`) so tests actually run.

## Measuring container boot/teardown vs test time

Container lifecycle (boot + migrate + teardown) dominates these suites. To see the split:

```bash
# JSON timing lines are gated on TESTCONTAINERS_TIMING locally (always on in CI),
# and need --disableConsoleIntercept so vitest doesn't swallow them.
TESTCONTAINERS_TIMING=1 pnpm exec vitest run <file> --disableConsoleIntercept
```

## Approximating the 2-core CI runner locally (flake repro)

To reproduce CI-like CPU pressure on a beefy local machine - useful when a test only flakes under
the 2-core CI runner:

```bash
# cap each testcontainer's CPU/mem (TESTCONTAINERS_CPU = cores, TESTCONTAINERS_MEMORY_GB = GB),
# and pin the test runner to 2 cores. Off unless the env vars are set.
TESTCONTAINERS_CPU=2 TESTCONTAINERS_MEMORY_GB=2 taskset -c 0,1 pnpm exec vitest run <file>
```

Note: in practice the scoped tests here are latency/IO/sleep-bound, not CPU-bound, so this changes
timings little - the original CI slowness was per-test container *boots*, which worker-scoping removed.
Keep it for the cases that genuinely starve on CPU (e.g. timing races against a worker poll).

## Timing harness

Or use the harness, which aggregates the split for you:

```bash
node internal-packages/testcontainers/scripts/measure-test-timing.mjs \
  src/client/client.test.ts --cwd internal-packages/clickhouse --runs 3
# -> run 1/3  passed=true  wall=10.58s  teardown=0.67s ...
```
