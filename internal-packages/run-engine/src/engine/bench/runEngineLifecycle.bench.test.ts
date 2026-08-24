/**
 * CPU benchmark for the run-engine and run-queue paths the production engine
 * service spends its time in.
 *
 * Two measured phases, profiled separately because blending them hides which
 * one owns a hot frame:
 *
 *  - enqueue: `engine.trigger()` at volume, the write path.
 *  - lifecycle: dequeue, start attempt, heartbeats, complete attempt, which is
 *    the loop a supervisor actually runs.
 *
 * Artifacts land in `.bench/` at the repo root: a `.cpuprofile` per phase plus
 * a JSON summary. Analyze a profile with:
 *
 *   pnpm --filter webapp exec tsx test/bench/analyzeProfile.ts <path-to-profile>
 *
 * Knobs, all optional:
 *   BENCH_RUNS, BENCH_CONSUMERS, BENCH_HEARTBEATS, BENCH_CONCURRENCY_LIMIT,
 *   BENCH_OUT_DIR, BENCH_SAMPLING_INTERVAL_US
 */
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { generateFriendlyId } from "@trigger.dev/core/v3/isomorphic";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";
import { InProcessProfiler } from "./inspectorProfiler.js";

vi.setConfig({ testTimeout: 900_000 });

const RUNS = Number(process.env.BENCH_RUNS ?? 1500);
const CONSUMERS = Number(process.env.BENCH_CONSUMERS ?? 8);
const HEARTBEATS_PER_RUN = Number(process.env.BENCH_HEARTBEATS ?? 2);
const CONCURRENCY_LIMIT = Number(process.env.BENCH_CONCURRENCY_LIMIT ?? 200);
const SAMPLING_INTERVAL_US = Number(process.env.BENCH_SAMPLING_INTERVAL_US ?? 200);
const OUT_DIR = process.env.BENCH_OUT_DIR ?? join(process.cwd(), "..", "..", ".bench");

const TASK_IDENTIFIER = "bench-task";
const WORKER_QUEUE = "main";

type PhaseResult = {
  phase: string;
  operations: number;
  durationMs: number;
  opsPerSecond: number;
  onCpuMs: number;
  cpuPerOperationMs: number;
  elu: ReturnType<InProcessProfiler["stopEluSampling"]>;
  profilePath: string;
  sampleCount: number;
};

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
}

function summarize(durations: number[]): { p50: number; p95: number; p99: number; mean: number } {
  const sorted = [...durations].sort((a, b) => a - b);
  return {
    mean: sorted.reduce((a, b) => a + b, 0) / (sorted.length || 1),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
  };
}

describe("run-engine CPU benchmark", () => {
  containerTest("enqueue and lifecycle under load", async ({ prisma, redisOptions }) => {
    await mkdir(OUT_DIR, { recursive: true });

    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");

    const engine = new RunEngine({
      prisma,
      worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
      queue: {
        redis: redisOptions,
        masterQueueConsumersDisabled: true,
        processWorkerQueueDebounceMs: 50,
      },
      runLock: { redis: redisOptions },
      machines: {
        defaultMachine: "small-1x",
        machines: {
          "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
        },
        baseCostInCents: 0.0005,
      },
      tracer: trace.getTracer("bench", "0.0.0"),
    });

    const results: PhaseResult[] = [];

    try {
      await prisma.runtimeEnvironment.update({
        where: { id: environment.id },
        data: { maximumConcurrencyLimit: CONCURRENCY_LIMIT },
      });
      environment.maximumConcurrencyLimit = CONCURRENCY_LIMIT;

      await setupBackgroundWorker(engine, environment, TASK_IDENTIFIER, undefined, undefined, {
        concurrencyLimit: CONCURRENCY_LIMIT,
      });
      await engine.runQueue.updateEnvConcurrencyLimits(environment);

      const enqueueDurations: number[] = [];
      const enqueueProfiler = new InProcessProfiler();
      await enqueueProfiler.startCpuProfile(SAMPLING_INTERVAL_US);
      enqueueProfiler.startEluSampling();

      const enqueueStart = performance.now();

      for (let i = 0; i < RUNS; i++) {
        const started = performance.now();
        await engine.trigger(
          {
            number: i + 1,
            friendlyId: generateFriendlyId("run"),
            environment,
            taskIdentifier: TASK_IDENTIFIER,
            payload: JSON.stringify({ index: i, message: "bench payload" }),
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: `t${i.toString().padStart(16, "0")}`,
            spanId: `s${i.toString().padStart(8, "0")}`,
            workerQueue: WORKER_QUEUE,
            queue: `task/${TASK_IDENTIFIER}`,
            isTest: false,
            tags: [],
          },
          prisma
        );
        enqueueDurations.push(performance.now() - started);
      }

      const enqueueDurationMs = performance.now() - enqueueStart;
      const enqueueElu = enqueueProfiler.stopEluSampling();
      const enqueueProfile = await enqueueProfiler.stopCpuProfile(
        join(OUT_DIR, "run-engine-enqueue.cpuprofile")
      );

      results.push({
        phase: "enqueue",
        operations: RUNS,
        durationMs: enqueueDurationMs,
        opsPerSecond: RUNS / (enqueueDurationMs / 1000),
        onCpuMs: enqueueProfile.onCpuMs,
        cpuPerOperationMs: enqueueProfile.onCpuMs / RUNS,
        elu: enqueueElu,
        profilePath: enqueueProfile.path,
        sampleCount: enqueueProfile.sampleCount,
      });

      console.log(
        `\n[enqueue] ${RUNS} runs in ${enqueueDurationMs.toFixed(0)}ms ` +
          `(${(RUNS / (enqueueDurationMs / 1000)).toFixed(1)} runs/s), ` +
          `on-cpu ${enqueueProfile.onCpuMs.toFixed(0)}ms ` +
          `(${(enqueueProfile.onCpuMs / RUNS).toFixed(2)}ms cpu/run), ` +
          `ELU mean ${(enqueueElu.mean * 100).toFixed(1)}% p95 ${(enqueueElu.p95 * 100).toFixed(1)}%`
      );
      console.log(`[enqueue] latency ${JSON.stringify(summarize(enqueueDurations))}`);

      await setTimeout(1000);

      const dequeueDurations: number[] = [];
      const startDurations: number[] = [];
      const heartbeatDurations: number[] = [];
      const completeDurations: number[] = [];

      let processed = 0;
      let emptyDequeues = 0;

      const lifecycleProfiler = new InProcessProfiler();
      await lifecycleProfiler.startCpuProfile(SAMPLING_INTERVAL_US);
      lifecycleProfiler.startEluSampling();

      const lifecycleStart = performance.now();

      await Promise.all(
        Array.from({ length: CONSUMERS }, async (_, consumerIndex) => {
          const consumerId = `bench_consumer_${consumerIndex}`;

          while (processed < RUNS && emptyDequeues < CONSUMERS * 5) {
            const dequeueStarted = performance.now();
            const dequeued = await engine.dequeueFromWorkerQueue({
              consumerId,
              workerQueue: WORKER_QUEUE,
              workerId: consumerId,
            });
            dequeueDurations.push(performance.now() - dequeueStarted);

            const message = dequeued[0];
            if (!message) {
              emptyDequeues += 1;
              await setTimeout(25);
              continue;
            }

            emptyDequeues = 0;
            processed += 1;

            const startStarted = performance.now();
            const attempt = await engine.startRunAttempt({
              runId: message.run.id,
              snapshotId: message.snapshot.id,
              workerId: consumerId,
            });
            startDurations.push(performance.now() - startStarted);

            let snapshotId = attempt.snapshot.id;

            for (let beat = 0; beat < HEARTBEATS_PER_RUN; beat++) {
              const heartbeatStarted = performance.now();
              const heartbeat = await engine.heartbeatRun({
                runId: message.run.id,
                snapshotId,
                workerId: consumerId,
              });
              heartbeatDurations.push(performance.now() - heartbeatStarted);
              snapshotId = heartbeat.snapshot.id;
            }

            const completeStarted = performance.now();
            await engine.completeRunAttempt({
              runId: message.run.id,
              snapshotId,
              workerId: consumerId,
              completion: {
                ok: true,
                id: message.run.id,
                outputType: "application/json",
                output: JSON.stringify({ done: true }),
              },
            });
            completeDurations.push(performance.now() - completeStarted);
          }
        })
      );

      const lifecycleDurationMs = performance.now() - lifecycleStart;
      const lifecycleElu = lifecycleProfiler.stopEluSampling();
      const lifecycleProfile = await lifecycleProfiler.stopCpuProfile(
        join(OUT_DIR, "run-engine-lifecycle.cpuprofile")
      );

      const lifecycleOperations =
        dequeueDurations.length +
        startDurations.length +
        heartbeatDurations.length +
        completeDurations.length;

      results.push({
        phase: "lifecycle",
        operations: lifecycleOperations,
        durationMs: lifecycleDurationMs,
        opsPerSecond: lifecycleOperations / (lifecycleDurationMs / 1000),
        onCpuMs: lifecycleProfile.onCpuMs,
        cpuPerOperationMs: lifecycleProfile.onCpuMs / (processed || 1),
        elu: lifecycleElu,
        profilePath: lifecycleProfile.path,
        sampleCount: lifecycleProfile.sampleCount,
      });

      console.log(
        `\n[lifecycle] ${processed} runs (${lifecycleOperations} engine calls) in ` +
          `${lifecycleDurationMs.toFixed(0)}ms (${(processed / (lifecycleDurationMs / 1000)).toFixed(1)} runs/s), ` +
          `on-cpu ${lifecycleProfile.onCpuMs.toFixed(0)}ms ` +
          `(${(lifecycleProfile.onCpuMs / (processed || 1)).toFixed(2)}ms cpu/run), ` +
          `ELU mean ${(lifecycleElu.mean * 100).toFixed(1)}% p95 ${(lifecycleElu.p95 * 100).toFixed(1)}%`
      );
      console.log(`[lifecycle] dequeue        ${JSON.stringify(summarize(dequeueDurations))}`);
      console.log(`[lifecycle] startAttempt   ${JSON.stringify(summarize(startDurations))}`);
      console.log(`[lifecycle] heartbeat      ${JSON.stringify(summarize(heartbeatDurations))}`);
      console.log(`[lifecycle] complete       ${JSON.stringify(summarize(completeDurations))}`);

      const summaryPath = join(OUT_DIR, "run-engine-bench-summary.json");
      await writeFile(
        summaryPath,
        JSON.stringify(
          {
            config: {
              runs: RUNS,
              consumers: CONSUMERS,
              heartbeatsPerRun: HEARTBEATS_PER_RUN,
              concurrencyLimit: CONCURRENCY_LIMIT,
              samplingIntervalUs: SAMPLING_INTERVAL_US,
            },
            phases: results,
            latency: {
              trigger: summarize(enqueueDurations),
              dequeue: summarize(dequeueDurations),
              startRunAttempt: summarize(startDurations),
              heartbeatRun: summarize(heartbeatDurations),
              completeRunAttempt: summarize(completeDurations),
            },
            processed,
          },
          null,
          2
        )
      );

      console.log(`\n[bench] artifacts written to ${OUT_DIR}`);
      expect(processed).toBeGreaterThan(0);
    } finally {
      await engine.quit();
    }
  });
});
