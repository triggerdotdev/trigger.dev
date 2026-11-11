import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import type { RedisOptions } from "@internal/redis";
import { setTimeout } from "timers/promises";
import { PassthroughControlPlaneResolver } from "../controlPlaneResolver.js";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

type Faults = {
  armed: boolean;
  // How many armed findRun reads (those selecting runtimeEnvironmentId) to reject.
  rejectFindRuns: number;
  // How many armed resolveEnv calls to reject.
  rejectResolveEnvs: number;
  injectedFindRuns: number;
  injectedResolveEnvs: number;
};

// Wraps the real PostgresRunStore and resolver. Dequeue preparation and the recovery's run read
// both select runtimeEnvironmentId; the snapshot helper's fallback read only selects { id }.
function faultyEngine(prisma: PrismaClient, redisOptions: RedisOptions, faults: Faults) {
  const base = new PostgresRunStore({ prisma, readOnlyPrisma: prisma });
  const store = new Proxy(base, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "findRun") {
        return (...args: any[]) => {
          if (
            faults.armed &&
            faults.injectedFindRuns < faults.rejectFindRuns &&
            args[1]?.select?.runtimeEnvironmentId
          ) {
            faults.injectedFindRuns++;
            return Promise.reject(new Error("injected run-store outage"));
          }
          return (value as Function).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  const baseResolver = new PassthroughControlPlaneResolver({ prisma });
  const controlPlaneResolver = new Proxy(baseResolver, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target);
      if (prop === "resolveEnv") {
        return (...args: any[]) => {
          if (faults.armed && faults.injectedResolveEnvs < faults.rejectResolveEnvs) {
            faults.injectedResolveEnvs++;
            return Promise.reject(new Error("injected control-plane outage"));
          }
          return (value as Function).apply(target, args);
        };
      }
      return typeof value === "function" ? value.bind(target) : value;
    },
  });

  return new RunEngine({
    prisma,
    store,
    controlPlaneResolver,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: {
      redis: redisOptions,
      // A budget of 1, so the first nack is the last and dead-letters the message.
      retryOptions: { maxAttempts: 1, minTimeoutInMs: 50, maxTimeoutInMs: 50 },
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: { redis: redisOptions },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": { name: "small-1x" as const, cpu: 0.5, memory: 0.5, centsPerMs: 0.0001 },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

async function dequeueWithFaults(prisma: PrismaClient, engine: RunEngine, faults: Faults) {
  const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  await setupBackgroundWorker(engine, env, "test-task");
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_dlq1",
      environment: env,
      taskIdentifier: "test-task",
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t1",
      spanId: "s1",
      workerQueue: "main",
      queue: "task/test-task",
      isTest: false,
      tags: [],
    },
    prisma
  );
  await setTimeout(500);

  const queued = await engine.getRunExecutionData({ runId: run.id });
  assertNonNullable(queued);
  expect(queued.snapshot.executionStatus).toBe("QUEUED");

  faults.armed = true;
  const dequeued = await engine.dequeueFromWorkerQueue({ consumerId: "c", workerQueue: "main" });
  faults.armed = false;
  // Long enough for any retry, requeue or heartbeat on a QUEUED run to have fired.
  await setTimeout(3_000);

  const inDlq = await engine.runQueue.messageInDeadLetterQueue(env, run.id);
  const after = await engine.getRunExecutionData({ runId: run.id });
  assertNonNullable(after);

  return { dequeued, inDlq, after };
}

describe("dequeue recovery nack", () => {
  // Catches: the recovery's "failed to find run" branch dropping a false nackMessage result, so a
  // run whose message was dead-lettered on its last attempt stayed PENDING with a QUEUED snapshot.
  containerTest(
    "a run dead-lettered after the recovery's run read fails is failed, not left QUEUED",
    async ({ prisma, redisOptions }) => {
      const faults: Faults = {
        armed: false,
        rejectFindRuns: Infinity,
        rejectResolveEnvs: 0,
        injectedFindRuns: 0,
        injectedResolveEnvs: 0,
      };
      const engine = faultyEngine(prisma, redisOptions, faults);
      try {
        const { dequeued, inDlq, after } = await dequeueWithFaults(prisma, engine, faults);

        // Both the preparation read and the recovery read were rejected.
        expect(faults.injectedFindRuns).toBeGreaterThanOrEqual(2);
        expect(dequeued.length).toBe(0);
        expect(inDlq).toBe(true);
        expect(after.run.status).toBe("SYSTEM_FAILURE");
        expect(after.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );

  // Catches: resolveEnv throwing inside the recovery escaping without a nack, so the message was
  // never dead-lettered and the run was never failed.
  containerTest(
    "a run whose environment cannot be resolved during recovery is nacked and failed",
    async ({ prisma, redisOptions }) => {
      const faults: Faults = {
        armed: false,
        // Only the preparation read fails, so the recovery reaches resolveEnv, which fails once.
        rejectFindRuns: 1,
        rejectResolveEnvs: 1,
        injectedFindRuns: 0,
        injectedResolveEnvs: 0,
      };
      const engine = faultyEngine(prisma, redisOptions, faults);
      try {
        const { dequeued, inDlq, after } = await dequeueWithFaults(prisma, engine, faults);

        expect(faults.injectedFindRuns).toBe(1);
        expect(faults.injectedResolveEnvs).toBe(1);
        expect(dequeued.length).toBe(0);
        expect(inDlq).toBe(true);
        expect(after.run.status).toBe("SYSTEM_FAILURE");
        expect(after.snapshot.executionStatus).toBe("FINISHED");
      } finally {
        await engine.quit();
      }
    }
  );
});
