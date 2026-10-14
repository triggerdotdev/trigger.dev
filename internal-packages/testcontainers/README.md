# Test containers

Vitest utilities for writing tests against real Postgres, Prisma, Redis and ClickHouse - we don't mock
(see the root `CLAUDE.md`), we boot containers. Also exposes a duration-weighted shard sequencer for
splitting slow suites across CI shards.

## Choosing a fixture

Postgres is shared much more widely than the other containers: one container per image is reused by
every test file and every test process on the machine (testcontainers reuse), and each test gets its
own database cloned from a schema template. Redis and ClickHouse are booted once per test file and
reset between tests. Reach for an isolated variant only when a test needs it.

| Fixture                          | Postgres           | Redis    | ClickHouse | Use for                                 |
| -------------------------------- | ------------------ | -------- | ---------- | --------------------------------------- |
| `redisTest`                      | -                  | shared   | -          | redis-only tests                        |
| `postgresTest`                   | shared (clone)     | -        | -          | db-only tests                           |
| `containerTest`                  | shared (clone)     | shared   | -          | the default: Postgres + Redis           |
| `containerTestWithClickhouse`    | shared (clone)     | shared   | shared     | tests that also read or write ClickHouse |
| `clickhouseTest`                 | -                  | -        | shared     | ClickHouse-only tests                   |
| `isolatedRedisTest`              | -                  | per-test | -          | background redis work (see below)       |
| `containerTestWithIsolatedRedis` | shared (clone)     | per-test | -          | background redis work + db              |
| `postgresAndRedisTest`           | per-file (clone)   | per-test | -          | logical replication slots               |
| `replicationContainerTest`       | per-file (clone)   | per-test | shared     | Postgres→ClickHouse logical replication |

"shared (clone)" = a Postgres reused across files and processes. Its schema lives in a template
database named by the schema's hash; each test gets a fast `CREATE DATABASE ... TEMPLATE` clone that is
dropped afterwards. "per-file (clone)" is the same, on a Postgres private to the test file, for tests
that create cluster-wide state under fixed names (replication slots).

Shared Postgres containers are not reaped when the run ends, so later runs skip the boot. Remove them
with `docker rm -f $(docker ps -aq --filter label=dev.trigger.testcontainers.shared)`, or set
`TESTCONTAINERS_REUSE_ENABLE=false` to get private containers.

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
_work_, not an equal _number of files_. The packing is deterministic, so every shard computes the same
bins and runs each file exactly once.

Configs opt in via:

```ts
import { DurationShardingSequencer } from "@internal/testcontainers/sequencer";
// in defineConfig:
test: {
  sequence: {
    sequencer: DurationShardingSequencer,
  },
}
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
