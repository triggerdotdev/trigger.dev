// Blip resilience through the REAL engine surface (not a store method in isolation): a run is
// triggered, executed, blocked on manual waitpoints, then each waitpoint is completed via
// engine.completeWaitpoint while the database connection is severed mid-statement. Every completion
// must ride out the blip (the run store retries the reissued statement) and the run must ultimately
// leave EXECUTING_WITH_WAITPOINTS. Uses the pg driver adapter (the production runtime).
import { containerBlipTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { PostgresRunStore } from "@internal/run-store";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

function buildEngine(prisma: PrismaClient, redisOptions: any, store: PostgresRunStore) {
  return new RunEngine({
    prisma,
    store,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
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

async function triggerExecutingRun(
  engine: RunEngine,
  prisma: PrismaClient,
  env: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  taskIdentifier: string,
  friendlyId: string,
  spanId: string
) {
  await setupBackgroundWorker(engine, env, taskIdentifier);
  const run = await engine.trigger(
    {
      number: 1,
      friendlyId,
      environment: env,
      taskIdentifier,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: `t-${spanId}`,
      spanId,
      workerQueue: "main",
      queue: `task/${taskIdentifier}`,
      isTest: false,
      tags: [],
    },
    prisma
  );
  await setTimeout(500);
  const dequeued = await engine.dequeueFromWorkerQueue({
    consumerId: `consumer-${spanId}`,
    workerQueue: "main",
  });
  await engine.startRunAttempt({ runId: dequeued[0].run.id, snapshotId: dequeued[0].snapshot.id });
  return run;
}

describe("waitpoint completion blip resilience (engine surface)", () => {
  containerBlipTest(
    "completeWaitpoint rides out a mid-statement blip and the run unblocks",
    { timeout: 120_000 },
    async ({ prisma, redisOptions, blip }) => {
      const client = prisma as PrismaClient;
      const env = await setupAuthenticatedEnvironment(client, "PRODUCTION");

      let retries = 0;
      const store = new PostgresRunStore({
        prisma: prisma as never,
        readOnlyPrisma: prisma as never,
        infraRetry: {
          options: { enabled: true, maxAttempts: 15, backoffMinMs: 10, backoffMaxMs: 60 },
          onRetry: () => {
            retries++;
          },
        },
      });
      const engine = buildEngine(client, redisOptions, store);

      try {
        const run = await triggerExecutingRun(
          engine,
          client,
          env,
          "wpblip-task",
          "run_wpblip",
          "s-wpblip"
        );

        const waitpointIds: string[] = [];
        for (let i = 0; i < 10; i++) {
          const { waitpoint } = await engine.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.projectId,
          });
          await engine.blockRunWithWaitpoint({
            runId: run.id,
            waitpoints: waitpoint.id,
            projectId: env.projectId,
            organizationId: env.organizationId,
          });
          waitpointIds.push(waitpoint.id);
        }

        // Complete every waitpoint through the real engine surface, severing the DB mid-statement on
        // each. Every completion must still succeed; at least one must actually ride out a blip.
        let caught = 0;
        for (const id of waitpointIds) {
          const before = retries;
          const completion = engine.completeWaitpoint({ id });
          await blip
            .severDuringNextStatement({ queryContains: "Waitpoint", timeoutMs: 6000, pollMs: 2 })
            .catch(() => {});
          const waitpoint = await completion;
          expect(waitpoint.status).toBe("COMPLETED");
          if (retries > before) caught++;
        }

        expect(caught).toBeGreaterThanOrEqual(1);

        // continueRunIfUnblocked runs as a debounced job; once all waitpoints are complete the run
        // must leave EXECUTING_WITH_WAITPOINTS.
        let status: string | undefined;
        for (let i = 0; i < 40; i++) {
          const execData = await engine.getRunExecutionData({ runId: run.id });
          status = execData?.snapshot.executionStatus;
          if (status && status !== "EXECUTING_WITH_WAITPOINTS") break;
          await setTimeout(250);
        }
        expect(status).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );
});
