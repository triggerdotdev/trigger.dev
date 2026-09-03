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
  completedWaitpointRecordsEnabled?: (args: { runId: string; organizationId: string }) => boolean
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
  // Asserts what is observable: that the predicate is consulted exactly once per resume, with
  // the right organisation, and that a false answer leaves the resume itself untouched.
  //
  // It does NOT assert that the call happens BEFORE the id scan. That ordering is not observable
  // from outside: `parseWaitpointId` is a pure function on ids the caller already holds, so a scan
  // leaves no trace, and proving the negative would need it stubbed -- which this repo does not do.
  // The ordering is held by the code instead: the predicate is the first statement in the method.
  containerTest(
    "is consulted exactly once per resume, with the run's organisation",
    async ({ prisma, redisOptions }) => {
      const consulted: { runId: string; organizationId: string }[] = [];
      const engine = engineWith(prisma as never, redisOptions as never, (args) => {
        consulted.push(args);
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

        // THREE waitpoints, not one. With a single blocker a gate consulted once per waitpoint
        // is indistinguishable from one consulted once per resume, so a one-waitpoint run cannot
        // hold the "exactly once" property this test exists for.
        const waitpoints = [];
        for (let i = 0; i < 3; i++) {
          const created = await engine.createManualWaitpoint({
            environmentId: env.id,
            projectId: env.projectId,
          });
          waitpoints.push(created.waitpoint.id);
        }

        await engine.blockRunWithWaitpoint({
          runId: run.id,
          waitpoints,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });

        // The LAST completion is the one that unblocks the run and reaches the gate.
        for (const id of waitpoints) {
          await engine.completeWaitpoint({ id });
        }

        const { completedWaitpointIds } = await waitForResume(engine, run.id);

        // The run resumed, because a disabled gate only skips the record build.
        expect(completedWaitpointIds).toEqual(expect.arrayContaining(waitpoints));

        // Exactly one consultation for this run, not merely at least one: a gate called per
        // waitpoint, or twice per resume, would satisfy a containment check.
        const forThisRun = consulted.filter((c) => c.runId === run.id);
        expect(forThisRun).toHaveLength(1);

        // And it carries the organisation the decision is keyed on, which is the whole reason the
        // predicate takes more than a run id.
        expect(forThisRun[0]?.organizationId).toBe(env.organization.id);
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
