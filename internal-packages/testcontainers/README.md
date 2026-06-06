# Test containers

Vitest utilities for writing tests against real Postgres, Prisma, Redis and ClickHouse - we don't mock
(see the root `CLAUDE.md`), we boot containers. Also exposes a duration-weighted shard sequencer for
splitting slow suites across CI shards.

## Choosing a fixture

Most tests share one set of containers per vitest worker (booted once, reset between tests) - this is
much faster than a container per test. Reach for an isolated variant only when a test needs it.

| Fixture | Postgres | Redis | ClickHouse | Use for |
| --- | --- | --- | --- | --- |
| `redisTest` | - | shared | - | redis-only tests |
| `postgresTest` | shared (clone) | - | - | db-only tests |
| `containerTest` | shared (clone) | shared | shared | the default - needs all three |
| `isolatedRedisTest` | - | per-test | - | background redis work (see below) |
| `containerTestWithIsolatedRedis` | shared (clone) | per-test | shared | background redis work + db/clickhouse |
| `replicationContainerTest` | per-test | per-test | shared | Postgres→ClickHouse logical replication |

"shared (clone)" = one Postgres per worker with a template database; each test gets a fast `CREATE
DATABASE ... TEMPLATE` clone, so schema isn't re-pushed per test.

### The background-work gotcha

If a test spawns work that **outlives the test body** - a `RunEngine`, a `redis-worker` Worker, a
`BatchQueue` - and that work isn't fully drained before the test ends, you **must** use an isolated
redis fixture (`isolatedRedisTest` / `containerTestWithIsolatedRedis`).

On the shared fixture, the leaked background loop keeps polling the one worker-scoped redis after the
test's clients close, bleeding into the next test. The symptom is an intermittent `"Connection is
closed"` error or a test that hangs until its timeout. `FLUSHALL` between tests does **not** fix this -
it clears data, not live connections/loops, so per-test key prefixes won't help either. A plain
db/redis test with no lingering background work is fine on the shared fixtures.

## Sharding (`./sequencer`)

CI splits the slow suites with `vitest --shard=i/N`. `DurationShardingSequencer` replaces vitest's
default file-count split with a duration-weighted one: it reads `test-timings.json` at the repo root
(`{ "<repo-relative path>": <ms> }`) and greedily bin-packs files so each shard does roughly equal
*work*, not an equal *number of files*. The packing is deterministic, so every shard computes the same
bins and runs each file exactly once.

Configs opt in via:

```ts
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
// in defineConfig:
test: { sequence: { sequencer: DurationShardingSequencer } }
```

### Adding tests - nothing to do

New test files are discovered by vitest's glob and sharded automatically. A file with no entry in
`test-timings.json` is given the **median** duration as a fallback, so it's still placed on exactly one
shard - correctness never depends on the timings being present or current.

What the timings affect is **balance**. A new heavy test estimated at the median can be under-weighted
and land on an already-full shard, making that shard slower. There's headroom between the current
makespan and the CI budget to absorb this, so it tolerates drift - but if a shard creeps toward the
budget, refresh the timings.

### Refreshing `test-timings.json`

Measure each shard with the JSON reporter and write per-file `endTime - startTime` (ms), keyed by
repo-relative path, back into `test-timings.json`. Set `GITHUB_ACTIONS=true` so suites that
`skipIf(CI)` are excluded, matching what actually runs on CI:

```bash
GITHUB_ACTIONS=true pnpm exec vitest run --reporter=json --outputFile=/tmp/run.json
```

Stale entries for deleted/renamed files are harmless (they're simply ignored). This is a periodic
chore, not a per-PR one.
