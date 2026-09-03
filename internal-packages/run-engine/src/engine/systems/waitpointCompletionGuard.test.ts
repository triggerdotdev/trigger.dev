// The write-ahead completion guard (ensureWaitpointCompleted) must durably deliver a manual/API
// waitpoint completion even when the inline path dies after arming: its redelivery handler replays
// the transition and the blocked-run fanout idempotently. These drive the real RunEngine + worker.
import { containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

function buildEngine(prisma: PrismaClient, redisOptions: any) {
  return new RunEngine({
    prisma,
    completionGuardDelayMs: 50,
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

async function blockOnWaitpoint(
  engine: RunEngine,
  env: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>,
  runId: string
) {
  const { waitpoint } = await engine.createManualWaitpoint({
    environmentId: env.id,
    projectId: env.projectId,
  });
  await engine.blockRunWithWaitpoint({
    runId,
    waitpoints: waitpoint.id,
    projectId: env.projectId,
    organizationId: env.organizationId,
  });
  return waitpoint;
}

async function waitForStatus(engine: RunEngine, runId: string, notStatus: string) {
  for (let i = 0; i < 40; i++) {
    const execData = await engine.getRunExecutionData({ runId });
    const status = execData?.snapshot.executionStatus;
    if (status && status !== notStatus) return status;
    await setTimeout(250);
  }
  return (await engine.getRunExecutionData({ runId }))?.snapshot.executionStatus;
}

describe("waitpoint completion guard", () => {
  // The guard fires (inline path never completed it) and delivers the completion + resume.
  containerTest(
    "ensureWaitpointCompleted replays the completion and resumes the run",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "guard-task",
          "run_guard1",
          "sg1"
        );
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        // Simulate the guard firing after a total inline failure: no prior completeWaitpoint ran.
        await engine.waitpointSystem.ensureWaitpointCompleted({
          waitpointId: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        const wp = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wp?.status).toBe("COMPLETED");
        expect(await waitForStatus(engine, run.id, "EXECUTING_WITH_WAITPOINTS")).toBe("EXECUTING");
      } finally {
        await engine.quit();
      }
    }
  );

  // Replaying an ALREADY-completed completion is a no-op: exactly one transition, one resume.
  containerTest(
    "a guard replay after a successful completion does not double-transition or double-resume",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(
          engine,
          prisma,
          env,
          "guard-task2",
          "run_guard2",
          "sg2"
        );
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        // Inline completion succeeds first...
        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: '{"n":1}', isError: false },
          armGuard: true,
        });
        expect(await waitForStatus(engine, run.id, "EXECUTING_WITH_WAITPOINTS")).toBe("EXECUTING");

        const completedAtBefore = (
          await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } })
        )?.completedAt;

        // ...then the guard fires anyway (e.g. its ack was lost). It must be a no-op.
        await engine.waitpointSystem.ensureWaitpointCompleted({
          waitpointId: waitpoint.id,
          output: { value: '{"n":2}', isError: false }, // a losing payload must not overwrite
        });

        const wp = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wp?.status).toBe("COMPLETED");
        expect(wp?.output).toBe('{"n":1}'); // first writer wins
        expect(wp?.completedAt?.getTime()).toBe(completedAtBefore?.getTime());
      } finally {
        await engine.quit();
      }
    }
  );
});
