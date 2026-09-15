# Engine CPU benchmarks

Two benchmarks for the paths the production engine service spends its CPU in, plus a
`.cpuprofile` analyzer. Neither runs in CI: they take minutes, attach the V8 profiler, and
report numbers rather than assert on them.

| bench | what it covers | where |
| --- | --- | --- |
| `engineHttp.bench.test.ts` | the full request stack for `engine/v1/worker-actions/*` | `apps/webapp` |
| `runEngineLifecycle.bench.test.ts` | run-engine and run-queue with no HTTP in the way | `internal-packages/run-engine` |

Artifacts (profiles + JSON summaries) land in `.bench/` at the repo root, which is gitignored.

## HTTP bench

Measures what a managed supervisor actually does: dequeue, start attempt, heartbeat,
read latest snapshot, complete attempt. Needs a built webapp.

```bash
pnpm run build --filter webapp
cd apps/webapp
pnpm run test:bench
```

It spawns a real webapp against throwaway Postgres and Redis containers, seeds a production
environment with a promoted managed deployment, fills the worker queue over the public
trigger API, then drives a closed-loop supervisor pool for the measured window.

The webapp is spawned with `--inspect` and profiled over CDP, so the profile covers only the
measured window rather than boot. Event-loop utilization is sampled **inside** the webapp
process over the same connection.

Knobs:

| var | default | meaning |
| --- | --- | --- |
| `BENCH_RUNS` | 1200 | runs queued before the window opens |
| `BENCH_SUPERVISORS` | 16 | concurrent virtual supervisors |
| `BENCH_HEARTBEATS` | 2 | heartbeats per run |
| `BENCH_DURATION_MS` | 60000 | measured window |
| `BENCH_SAMPLING_INTERVAL_US` | 200 | V8 sampling interval |
| `BENCH_PROFILE_NAME` | `engine-http` | artifact basename |
| `BENCH_EXTRA_ENV` | — | JSON merged into the webapp's env |
| `BENCH_OUT_DIR` | `<repo>/.bench` | artifact directory |

`BENCH_EXTRA_ENV` plus `BENCH_PROFILE_NAME` is how you A/B a single flag:

```bash
BENCH_RUNS=5000 BENCH_SUPERVISORS=24 BENCH_DURATION_MS=90000 \
  BENCH_PROFILE_NAME=engine-http-no-elm \
  BENCH_EXTRA_ENV='{"EVENT_LOOP_MONITOR_ENABLED":"0"}' \
  pnpm run test:bench
```

Run the same size for both arms and compare `on-cpu ms per completed run` rather than
throughput: throughput on a laptop moves ~5% run to run, on-CPU per unit of work is far
steadier.

## Run-engine bench

No HTTP, no webapp: drives `RunEngine` directly so engine and queue costs are not mixed with
request-stack overhead. Profiles two phases separately, because blending them hides which one
owns a hot frame.

```bash
cd internal-packages/run-engine
pnpm run test:bench
```

Knobs: `BENCH_RUNS`, `BENCH_CONSUMERS`, `BENCH_HEARTBEATS`, `BENCH_CONCURRENCY_LIMIT`,
`BENCH_SAMPLING_INTERVAL_US`, `BENCH_OUT_DIR`.

The driver shares a process with the code under measurement, so its own cost is in the
profile. It is a thin await loop and appears under its own frames rather than smeared across
engine frames.

## Analyzing a profile

```bash
pnpm --filter webapp exec tsx test/bench/analyzeProfile.ts .bench/engine-http.cpuprofile --top 30
```

Three views: CPU by bucket (which package owns the cycles), hottest frames by self time (what
to go fix), and hottest frames by total time (entry points, and a check that the load
exercised the route mix you intended). Frames are symbolicated through the build's source
maps, so bundled chunks report as the source files they came from.

Percentages are shares of **on-CPU** time, with V8's `(idle)` and `(program)` excluded. A
share of wall clock would make everything look cheap whenever the bench was IO-bound.

`--json <path>` writes the full analysis for diffing two runs.
