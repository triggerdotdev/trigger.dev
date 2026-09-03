// The write-ahead completion guard (ensureWaitpointCompleted) must durably deliver a manual/API
// waitpoint completion even when the inline path dies after arming: its redelivery handler replays
// the transition and the blocked-run fanout idempotently. These drive the real RunEngine + worker.
import { containerTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "../tests/setup.js";

// A real store that injects a transient connectivity fault into the completion write, so the inline
// path fails after the guard is armed and only the guard's replay delivers the completion. `super.*`
// runs the genuine store — never a mock.
class FaultCompletionStore extends PostgresRunStore {
  public mode: "healthy" | "throwBeforeCommit" | "commitThenThrow" = "healthy";
  public faultsRemaining = 0;

  override async updateManyWaitpoints(
    args: Parameters<PostgresRunStore["updateManyWaitpoints"]>[0],
    tx?: any
  ): ReturnType<PostgresRunStore["updateManyWaitpoints"]> {
    if (this.faultsRemaining > 0 && this.mode !== "healthy") {
      this.faultsRemaining--;
      if (this.mode === "commitThenThrow") {
        await super.updateManyWaitpoints(args, tx); // real commit, then the ack is "lost"
      }
      throw Object.assign(
        new Error("Client has encountered a connection error and is not queryable"),
        { name: "PrismaClientUnknownRequestError" }
      );
    }
    return super.updateManyWaitpoints(args, tx);
  }
}

function buildEngine(prisma: PrismaClient, redisOptions: any, store?: PostgresRunStore) {
  return new RunEngine({
    prisma,
    ...(store ? { store } : {}),
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

  // Fault 2: the completion update commits but its acknowledgement is lost after the guard is armed.
  containerTest(
    "commit-then-ack-lost: the guard resumes the run exactly once",
    async ({ prisma, redisOptions }) => {
      const store = new FaultCompletionStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "guard-ack", "run_ackl", "sga");
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        store.mode = "commitThenThrow";
        store.faultsRemaining = 1;

        // Inline path arms the guard, commits, then throws (ack lost). The API swallows it.
        await engine
          .completeWaitpoint({
            id: waitpoint.id,
            output: { value: "{}", isError: false },
            armGuard: true,
          })
          .catch(() => {});

        // The guard fires and delivers the resume; the committed transition is not repeated.
        expect(await waitForStatus(engine, run.id, "EXECUTING_WITH_WAITPOINTS")).toBe("EXECUTING");
        const wp = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wp?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // Fault 9: flag off (armGuard=false) — completion resumes normally and no guard is armed.
  containerTest(
    "flag off arms no guard and completion still resumes the run",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions); // isBlipRetryEnabled defaults off
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "guard-off", "run_off1", "sgo");
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        // armGuard omitted (false): the guard arm path is skipped entirely.
        await engine.completeWaitpoint({
          id: waitpoint.id,
          output: { value: "{}", isError: false },
        });

        expect(await waitForStatus(engine, run.id, "EXECUTING_WITH_WAITPOINTS")).toBe("EXECUTING");
        const wp = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wp?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );

  // Fault 1: the completion update never commits (throws before commit) after the guard is armed.
  containerTest(
    "armed-but-never-committed: the guard completes and resumes the run",
    async ({ prisma, redisOptions }) => {
      const store = new FaultCompletionStore({ prisma, readOnlyPrisma: prisma });
      const engine = buildEngine(prisma, redisOptions, store);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "guard-nc", "run_ncmt", "sgn");
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        store.mode = "throwBeforeCommit";
        store.faultsRemaining = 1;

        await engine
          .completeWaitpoint({
            id: waitpoint.id,
            output: { value: "{}", isError: false },
            armGuard: true,
          })
          .catch(() => {});

        // Nothing committed inline; the guard's replay performs the transition + fanout.
        expect(await waitForStatus(engine, run.id, "EXECUTING_WITH_WAITPOINTS")).toBe("EXECUTING");
        const wp = await prisma.waitpoint.findFirst({ where: { id: waitpoint.id } });
        expect(wp?.status).toBe("COMPLETED");
      } finally {
        await engine.quit();
      }
    }
  );
});
