// The O(1) gate in front of the completed-waitpoint record build.
//
// Deciding whether to build a record set by scanning a run's blocking waitpoints made every
// resume, for every organisation, pay work proportional to its fan-in to reach the same answer:
// no. The predicate moves that decision in front of the scan, and defaults to never.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { expect } from "vitest";
import { RunEngine } from "../index.js";
import { setTimeout } from "node:timers/promises";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

// The trigger has to reach the queue, and the completion resumes the run out of band, so both
// need settling before the assertions read state back.
const SETTLE_MS = 500;

async function waitForResume(
  engine: RunEngine,
  runId: string
): Promise<{ completedWaitpointIds: string[] }> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const data = await engine.getRunExecutionData({ runId });
    const ids = data?.completedWaitpoints?.map((w) => w.id) ?? [];
    if (ids.length > 0) {
      return { completedWaitpointIds: ids };
    }
    await setTimeout(100);
  }
  return { completedWaitpointIds: [] };
}

vi.setConfig({ testTimeout: 60_000 });

function engineWith(
  prisma: never,
  redisOptions: never,
  completedWaitpointRecordsEnabled?: (runId: string) => boolean
) {
  return new RunEngine({
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
    ...(completedWaitpointRecordsEnabled && { completedWaitpointRecordsEnabled }),
  });
}

describe("the completed-waitpoint records gate", () => {
  containerTest(
    "is consulted once per resume, and the resume is unaffected",
    async ({ prisma, redisOptions }) => {
      const consulted: string[] = [];
      const engine = engineWith(prisma as never, redisOptions as never, (runId) => {
        consulted.push(runId);
        return false;
      });

      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, env, taskIdentifier);

        const run = await engine.trigger(
          {
            number: 1,
            friendlyId: "run_gate1",
            environment: env,
            taskIdentifier,
            payload: "{}",
            payloadType: "application/json",
            context: {},
            traceContext: {},
            traceId: "t12345",
            spanId: "s12345",
            workerQueue: "main",
            queue: `task/${taskIdentifier}`,
            isTest: false,
            tags: [],
          },
          prisma
        );

        await setTimeout(SETTLE_MS);
        const dequeued = await engine.dequeueFromWorkerQueue({
          consumerId: "test_12345",
          workerQueue: "main",
        });
        const attempt = await engine.startRunAttempt({
          runId: dequeued[0]!.run.id,
          snapshotId: dequeued[0]!.snapshot.id,
        });

        // Block on a manual waitpoint, then release it: the release is what resumes the run and
        // reaches the gate.
        const waitpoint = await engine.createManualWaitpoint({
          environmentId: env.id,
          projectId: env.projectId,
        });
        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints: [waitpoint.waitpoint.id],
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });

        const { completedWaitpointIds } = await waitForResume(engine, run.id);

        // The run resumed, because a disabled gate only skips the record build...
        expect(completedWaitpointIds).toContain(waitpoint.waitpoint.id);
        // ...and the gate was consulted for it, which is what puts it in the resume path.
        expect(consulted).toContain(run.id);
        expect(attempt.run.id).toBe(run.id);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("defaults to never, so no resume consults it", async ({ prisma, redisOptions }) => {
    // No predicate supplied, which is every deployment until the store that consumes a record set
    // is wired. The default has to be a constant false rather than a scan, or the cost this gate
    // exists to remove comes straight back for everyone.
    const engine = engineWith(prisma as never, redisOptions as never);

    try {
      const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, env, taskIdentifier);

      const run = await engine.trigger(
        {
          number: 1,
          friendlyId: "run_gate2",
          environment: env,
          taskIdentifier,
          payload: "{}",
          payloadType: "application/json",
          context: {},
          traceContext: {},
          traceId: "t22345",
          spanId: "s22345",
          workerQueue: "main",
          queue: `task/${taskIdentifier}`,
          isTest: false,
          tags: [],
        },
        prisma
      );

      await setTimeout(SETTLE_MS);
      const dequeued = await engine.dequeueFromWorkerQueue({
        consumerId: "test_22345",
        workerQueue: "main",
      });
      await engine.startRunAttempt({
        runId: dequeued[0]!.run.id,
        snapshotId: dequeued[0]!.snapshot.id,
      });

      const waitpoint = await engine.createManualWaitpoint({
        environmentId: env.id,
        projectId: env.projectId,
      });
      await engine.blockRunWithWaitpoint({
        runId: run.id,
        waitpoints: [waitpoint.waitpoint.id],
        projectId: env.project.id,
        organizationId: env.organization.id,
      });

      await engine.completeWaitpoint({ id: waitpoint.waitpoint.id });

      const { completedWaitpointIds } = await waitForResume(engine, run.id);
      expect(completedWaitpointIds).toContain(waitpoint.waitpoint.id);
    } finally {
      await engine.quit();
    }
  });
});
