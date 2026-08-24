// The read gate: the engine's own snapshot flows, run against the decorator with reads served from
// Redis. Same flows, same expectations, different store underneath — the point is that nothing in
// the engine has to know, so no existing suite is modified to make this pass.
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { setTimeout } from "timers/promises";
import { generateInternalId, RunId } from "@trigger.dev/core/v3/isomorphic";
import { RunEngine } from "../index.js";
import { buildDecoratedStore, type DecoratedStoreHarness } from "./helpers/decoratedStore.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function engineOptions(prisma: any, redisOptions: any, harness: DecoratedStoreHarness) {
  return {
    prisma,
    store: harness.store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x" as const,
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  };
}

const triggerArgs = (taskIdentifier: string, environment: any, n: number) => ({
  number: n,
  // A real minted friendly id: the engine converts it back with RunId.fromFriendlyId, which
  // rejects anything that is not the prefix plus a cuid body.
  friendlyId: RunId.generate().friendlyId,
  environment,
  taskIdentifier,
  payload: "{}",
  payloadType: "application/json",
  context: {},
  traceContext: {},
  traceId: `t_gate_${n}`,
  spanId: `s_gate_${n}`,
  workerQueue: "main",
  queue: `task/${taskIdentifier}`,
  isTest: false,
  tags: [],
});

describe("snapshot store read gate", () => {
  containerTest(
    "drives a run to completion with every snapshot read served from Redis",
    async ({ prisma, redisOptions }) => {
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        readPercent: 100,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "gate-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(triggerArgs(taskIdentifier, environment, 1), prisma);
        await setTimeout(500);

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "gate_consumer",
          workerQueue: "main",
        });
        expect(dequeued.length).toBe(1);

        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        expect(attempt.run.status).toBe("EXECUTING");

        await engine.completeRunAttempt({
          runId: run.id,
          snapshotId: attempt.snapshot.id,
          completion: { ok: true, id: run.id, output: `{"done":true}`, outputType: "application/json" },
        });

        const finished = await prisma.taskRun.findFirstOrThrow({ where: { id: run.id } });
        expect(finished.status).toBe("COMPLETED_SUCCESSFULLY");

        // The gate: the engine read its snapshots, and Redis is what answered.
        const fromRedis = harness.reads.filter((r) => r.source === "redis");
        expect(fromRedis.length).toBeGreaterThan(0);
        expect(harness.reads.filter((r) => r.source === "postgres")).toEqual([]);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "serves getRunExecutionData from Redis at every step",
    async ({ prisma, redisOptions }) => {
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        readPercent: 100,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "gate-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(triggerArgs(taskIdentifier, environment, 2), prisma);
        await setTimeout(500);

        const queued = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(queued);
        expect(queued.snapshot.executionStatus).toBe("QUEUED");

        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "gate_consumer",
          workerQueue: "main",
        });
        const pending = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(pending);
        expect(pending.snapshot.executionStatus).toBe("PENDING_EXECUTING");

        await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });
        const executing = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(executing);
        expect(executing.snapshot.executionStatus).toBe("EXECUTING");
        expect(executing.run.attemptNumber).toBe(1);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "keeps the environment boundary on a snapshot read",
    async ({ prisma, redisOptions }) => {
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        readPercent: 100,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "gate-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(triggerArgs(taskIdentifier, environment, 3), prisma);
        await setTimeout(500);

        // Scoped to its own environment the run reads normally.
        const own = await engine.getRunExecutionData({
          runId: run.id,
          environmentId: environment.id,
        });
        assertNonNullable(own);

        // Scoped to any other environment the run must not leak across the tenant boundary. The
        // assertion is parity rather than a fixed shape: whatever Postgres answers for this call,
        // Redis has to answer the same, or the boundary behaves differently once reads move over.
        const foreignEnvironmentId = generateInternalId();

        const viaRedis = await engine
          .getRunExecutionData({ runId: run.id, environmentId: foreignEnvironmentId })
          .catch((error: unknown) => ({ threw: (error as Error).constructor.name }));

        const postgresOnly = buildDecoratedStore({ prisma, redisOptions, mode: "off" });
        const engineOff = new RunEngine(
          engineOptions(prisma, redisOptions, postgresOnly) as never
        );
        let viaPostgres: unknown;
        try {
          viaPostgres = await engineOff
            .getRunExecutionData({ runId: run.id, environmentId: foreignEnvironmentId })
            .catch((error: unknown) => ({ threw: (error as Error).constructor.name }));
        } finally {
          await engineOff.quit();
          await postgresOnly.quit();
        }

        expect(viaRedis).toEqual(viaPostgres);
        // And whatever that shape is, it must not be the run's data.
        expect(viaRedis).not.toMatchObject({ run: { id: run.id } });
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest(
    "serves a since-window wider than the cap from Redis",
    async ({ prisma, redisOptions }) => {
      const harness = buildDecoratedStore({
        prisma,
        redisOptions,
        mode: "redis-read",
        readPercent: 100,
      });
      const engine = new RunEngine(engineOptions(prisma, redisOptions, harness) as never);

      try {
        const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "gate-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const run = await engine.trigger(triggerArgs(taskIdentifier, environment, 4), prisma);
        await setTimeout(500);

        const first = await engine.getRunExecutionData({ runId: run.id });
        assertNonNullable(first);

        // More transitions than the 50-cap, so the window is exercised at its boundary.
        for (let i = 0; i < 60; i++) {
          await harness.store.createExecutionSnapshot({
            run: { id: run.id, status: "PENDING", attemptNumber: null },
            snapshot: { executionStatus: "QUEUED", description: `filler ${i}` },
            environmentId: environment.id,
            environmentType: environment.type,
            projectId: environment.project.id,
            organizationId: environment.organization.id,
          });
        }

        const since = await engine.getSnapshotsSince({
          runId: run.id,
          snapshotId: first.snapshot.id,
        });
        assertNonNullable(since);

        // The newest 50, ascending — the same window Postgres would have produced.
        expect(since.length).toBe(50);
        expect(since[since.length - 1]!.snapshot.description).toBe("filler 59");
        expect(harness.reads.some((r) => r.source === "redis")).toBe(true);
      } finally {
        await engine.quit();
        await harness.quit();
      }
    }
  );

  containerTest("falls back to Postgres for a pre-cutover run", async ({ prisma, redisOptions }) => {
    // A run created while the dial was off has no keyspace. Turning reads on must not lose it.
    const off = buildDecoratedStore({ prisma, redisOptions, mode: "off" });
    const engineOff = new RunEngine(engineOptions(prisma, redisOptions, off) as never);

    let runId: string;
    let environment: any;
    try {
      environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      await setupBackgroundWorker(engineOff, environment, "gate-task");
      const run = await engineOff.trigger(triggerArgs("gate-task", environment, 5), prisma);
      runId = run.id;
      await setTimeout(500);
    } finally {
      await engineOff.quit();
      await off.quit();
    }

    const on = buildDecoratedStore({
      prisma,
      redisOptions,
      mode: "redis-read",
      readPercent: 100,
    });
    const engineOn = new RunEngine(engineOptions(prisma, redisOptions, on) as never);
    try {
      const data = await engineOn.getRunExecutionData({ runId });
      assertNonNullable(data);
      expect(data.snapshot.executionStatus).toBe("QUEUED");
      expect(on.reads.some((r) => r.source === "postgres")).toBe(true);
    } finally {
      await engineOn.quit();
      await on.quit();
    }
  });
});
