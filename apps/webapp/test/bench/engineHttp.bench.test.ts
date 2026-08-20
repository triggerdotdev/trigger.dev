/**
 * CPU benchmark for the engine-facing HTTP surface: the
 * `engine/v1/worker-actions/*` routes a managed supervisor calls.
 *
 * Unlike the run-engine bench, this measures the whole request stack — Remix
 * routing, `createActionWorkerApiRoute`, worker-token auth, zod validation,
 * JSON encode/decode — on top of the engine work, which is where a large share
 * of the production engine service's event-loop time actually goes.
 *
 * The webapp runs as a child process with `--inspect`, and the profiler is
 * driven over CDP so the profile covers only the measured window rather than
 * boot. Artifacts land in `.bench/` at the repo root. Analyze one with:
 *
 *   pnpm --filter webapp exec tsx test/bench/analyzeProfile.ts <path>
 *
 * Knobs, all optional:
 *   BENCH_RUNS, BENCH_SUPERVISORS, BENCH_HEARTBEATS, BENCH_DURATION_MS,
 *   BENCH_OUT_DIR, BENCH_SAMPLING_INTERVAL_US
 */
import { startTestServer, type TestServer } from "@internal/testcontainers/webapp";
import { createServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { WebappProfiler } from "./lib/cdp";
import { seedEngineFixtures, workerHeaders, type EngineFixtures } from "./lib/engineFixtures";
import { formatStatsTable, LatencyRecorder, runLoad } from "./lib/loadDriver";

vi.setConfig({ testTimeout: 900_000 });

const RUNS = Number(process.env.BENCH_RUNS ?? 1200);
const SUPERVISORS = Number(process.env.BENCH_SUPERVISORS ?? 16);
const HEARTBEATS_PER_RUN = Number(process.env.BENCH_HEARTBEATS ?? 2);
const DURATION_MS = Number(process.env.BENCH_DURATION_MS ?? 60_000);
const SAMPLING_INTERVAL_US = Number(process.env.BENCH_SAMPLING_INTERVAL_US ?? 200);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(process.cwd(), "..", "..", ".bench");
const PROFILE_NAME = process.env.BENCH_PROFILE_NAME ?? "engine-http";

/**
 * JSON object merged into the spawned webapp's environment, for A/B runs
 * against a single flag, e.g.
 * `BENCH_EXTRA_ENV='{"EVENT_LOOP_MONITOR_ENABLED":"0"}'`.
 */
const EXTRA_WEBAPP_ENV: Record<string, string> = process.env.BENCH_EXTRA_ENV
  ? JSON.parse(process.env.BENCH_EXTRA_ENV)
  : {};

async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, () => {
      const { port } = server.address() as { port: number };
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

let server: TestServer;
let profiler: WebappProfiler;
let fixtures: EngineFixtures;
let inspectPort: number;

beforeAll(async () => {
  inspectPort = await findFreePort();
  server = await startTestServer({
    extraEnv: {
      NODE_OPTIONS: `--inspect=${inspectPort}`,
      API_RATE_LIMIT_MAX: "1000000",
      API_RATE_LIMIT_REFILL_RATE: "1000000",
      ...EXTRA_WEBAPP_ENV,
    },
    overrideEnv: { RUN_ENGINE_WORKER_ENABLED: "1" },
  });
  profiler = await WebappProfiler.attach(inspectPort);
}, 300_000);

afterAll(async () => {
  profiler?.detach();
  await server?.stop();
}, 120_000);

/**
 * Seeds the worker queue. Failures are counted by status and surfaced rather
 * than swallowed: a partially-filled queue silently turns the measured window
 * into mostly-empty dequeues, which reads as a fast server rather than a
 * broken fixture.
 */
async function triggerRuns(count: number): Promise<number> {
  let triggered = 0;
  const failures = new Map<number, { count: number; sample: string }>();

  const batches = Math.ceil(count / 50);
  for (let batch = 0; batch < batches; batch++) {
    const size = Math.min(50, count - batch * 50);
    const responses = await Promise.all(
      Array.from({ length: size }, (_, i) => {
        const index = batch * 50 + i;
        const taskId = fixtures.taskIdentifiers[index % fixtures.taskIdentifiers.length]!;
        return server.webapp.fetch(`/api/v1/tasks/${taskId}/trigger`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${fixtures.environmentApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ payload: { index, message: "bench payload" } }),
        });
      })
    );

    for (const res of responses) {
      if (res.ok) {
        triggered += 1;
        continue;
      }
      const existing = failures.get(res.status);
      if (existing) existing.count += 1;
      else failures.set(res.status, { count: 1, sample: (await res.text()).slice(0, 200) });
    }
  }

  if (failures.size > 0) {
    const detail = [...failures.entries()]
      .map(([status, { count: n, sample }]) => `${status} x${n} (${sample})`)
      .join("; ");
    console.warn(`[engine-http] ${count - triggered}/${count} triggers failed: ${detail}`);
  }

  if (triggered < count * 0.9) {
    throw new Error(`only ${triggered}/${count} runs were queued; the measured window would idle`);
  }

  return triggered;
}

describe("engine worker-action HTTP CPU benchmark", () => {
  it("profiles the supervisor request loop", async () => {
    await mkdir(OUT_DIR, { recursive: true });

    fixtures = await seedEngineFixtures(server.prisma, { taskCount: 4 });

    const triggered = await triggerRuns(RUNS);
    expect(triggered).toBeGreaterThan(0);

    const recorder = new LatencyRecorder();
    let dequeuedRuns = 0;
    let completedRuns = 0;
    let emptyDequeues = 0;

    await profiler.startCpuProfile(SAMPLING_INTERVAL_US);
    profiler.startEluSampling();
    recorder.begin();

    await runLoad({
      concurrency: SUPERVISORS,
      durationMs: DURATION_MS,
      iteration: async (workerIndex) => {
        const headers = workerHeaders(fixtures, `bench-instance-${workerIndex}`);

        const dequeueResponse = await recorder.time("POST worker-actions/dequeue", async () => {
          const res = await server.webapp.fetch("/engine/v1/worker-actions/dequeue", {
            method: "POST",
            headers,
            body: JSON.stringify({}),
          });
          if (!res.ok) throw new Error(`dequeue ${res.status}`);
          return (await res.json()) as Array<{
            run: { friendlyId: string };
            snapshot: { friendlyId: string };
          }>;
        });

        const message = dequeueResponse?.[0];
        if (!message) {
          emptyDequeues += 1;
          await new Promise((r) => setTimeout(r, 25));
          return;
        }

        dequeuedRuns += 1;
        const runId = message.run.friendlyId;
        let snapshotId = message.snapshot.friendlyId;

        const attempt = await recorder.time("POST attempts/start", async () => {
          const res = await server.webapp.fetch(
            `/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/start`,
            { method: "POST", headers, body: JSON.stringify({}) }
          );
          if (!res.ok) throw new Error(`start ${res.status}`);
          return (await res.json()) as { snapshot: { friendlyId: string } };
        });

        if (!attempt) return;
        snapshotId = attempt.snapshot.friendlyId;

        for (let beat = 0; beat < HEARTBEATS_PER_RUN; beat++) {
          await recorder.time("POST snapshots/heartbeat", async () => {
            const res = await server.webapp.fetch(
              `/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/heartbeat`,
              { method: "POST", headers, body: JSON.stringify({}) }
            );
            if (!res.ok) throw new Error(`heartbeat ${res.status}`);
            return res.json();
          });
        }

        await recorder.time("GET snapshots/latest", async () => {
          const res = await server.webapp.fetch(
            `/engine/v1/worker-actions/runs/${runId}/snapshots/latest`,
            { headers }
          );
          if (!res.ok) throw new Error(`latest ${res.status}`);
          return res.json();
        });

        const completed = await recorder.time("POST attempts/complete", async () => {
          const res = await server.webapp.fetch(
            `/engine/v1/worker-actions/runs/${runId}/snapshots/${snapshotId}/attempts/complete`,
            {
              method: "POST",
              headers,
              body: JSON.stringify({
                completion: {
                  ok: true,
                  id: runId,
                  outputType: "application/json",
                  output: JSON.stringify({ done: true }),
                },
              }),
            }
          );
          if (!res.ok) throw new Error(`complete ${res.status}`);
          return res.json();
        });

        if (completed) completedRuns += 1;
      },
    });

    recorder.end();
    const elu = profiler.stopEluSampling();
    const profile = await profiler.stopCpuProfile(join(OUT_DIR, `${PROFILE_NAME}.cpuprofile`));

    const stats = recorder.stats();
    const totals = recorder.totals();

    console.log(`\n${formatStatsTable(stats)}`);
    console.log(
      `\n[engine-http] ${totals.count} requests (${totals.errors} errors) at ` +
        `${totals.throughputPerSecond.toFixed(1)} req/s | ` +
        `${dequeuedRuns} dequeued, ${completedRuns} completed, ${emptyDequeues} empty dequeues`
    );
    console.log(
      `[engine-http] webapp ELU mean ${(elu.stats.mean * 100).toFixed(1)}% ` +
        `p50 ${(elu.stats.p50 * 100).toFixed(1)}% ` +
        `p95 ${(elu.stats.p95 * 100).toFixed(1)}% ` +
        `max ${(elu.stats.max * 100).toFixed(1)}% (${elu.stats.sampleCount} samples)`
    );
    console.log(`[engine-http] profile: ${profile.path} (${profile.sampleCount} samples)`);

    await writeFile(
      join(OUT_DIR, `${PROFILE_NAME}-bench-summary.json`),
      JSON.stringify(
        {
          config: {
            runs: RUNS,
            supervisors: SUPERVISORS,
            heartbeatsPerRun: HEARTBEATS_PER_RUN,
            durationMs: DURATION_MS,
            samplingIntervalUs: SAMPLING_INTERVAL_US,
          },
          triggered,
          dequeuedRuns,
          completedRuns,
          emptyDequeues,
          totals,
          operations: stats,
          elu: elu.stats,
          eluSamples: elu.samples,
          profilePath: profile.path,
        },
        null,
        2
      )
    );

    expect(dequeuedRuns).toBeGreaterThan(0);
  });
});
