import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";
import { setTimeout } from "timers/promises";

vi.setConfig({ testTimeout: 60_000 });

describe("RunEngine Waitpoints – race condition", () => {
  containerTest(
    "join-row removed before run continues (failing race)",
    async ({ prisma, redisOptions }) => {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = new RunEngine({
        prisma,
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

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_race",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "race-trace",
            spanId: "race-span",
            masterQueue: "main",
            queue: "task/test-task",
            isTest: false,
            tags: [],
          },
          prisma
        );

        const dequeued = await engine.dequeueFromMasterQueue({
          consumerId: "test",
          masterQueue: run.masterQueue,
          maxRunCount: 10,
        });
        await engine.startRunAttempt({
          runId: dequeued[0].run.id,
          snapshotId: dequeued[0].snapshot.id,
        });

        // create manual waitpoint
        const { waitpoint } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        // block the run
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        // Now we need to block the run again right after the continueRunIfUnblocked function
        // is called as a result of the above completeWaitpoint call
        const { waitpoint: waitpoint2 } = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });

        engine.registerRacepointForRun({ runId: run.id, waitInterval: 1000 });

        // complete the waitpoint (this will schedule a continueRunIfUnblocked job normally)
        await engine.completeWaitpoint({ id: waitpoint.id });

        await engine.waitpointSystem.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: waitpoint2.id,
          projectId: env.projectId,
          organizationId: env.organizationId,
        });

        await setTimeout(1000);

        // The join row SHOULD still exist until the run progresses naturally.
        const joinRow = await prisma.taskRunWaitpoint.findFirst({
          where: { taskRunId: run.id, waitpointId: waitpoint2.id },
        });

        console.log("joinRow", joinRow);

        // Intentionally expect it to still be there – current implementation erroneously deletes it so test fails.
        expect(joinRow).not.toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );
});
