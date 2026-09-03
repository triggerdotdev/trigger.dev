// The write-ahead completion guard (ensureWaitpointCompleted) must durably deliver a manual/API
// waitpoint completion even when the inline path dies after arming: its redelivery handler replays
// the transition and the blocked-run fanout idempotently. These drive the real RunEngine + worker.
import { containerTest } from "@internal/testcontainers";
import { PostgresRunStore } from "@internal/run-store";
import { SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { trace } from "@internal/tracing";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { setTimeout } from "node:timers/promises";
import { RunEngine } from "../index.js";
import { getLatestExecutionSnapshot } from "./executionSnapshotSystem.js";
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

  // An interrupted resume can commit the run's advance past EXECUTING_WITH_WAITPOINTS but crash before
  // deleting the blocking edge. A re-run of continueRunIfUnblocked (worker-job retry / guard replay)
  // must idempotently finalize: clear the leaked edge instead of early-returning and stranding it.
  // EXECUTING additionally re-notifies the worker (the notification is emitted just before the delete,
  // so a leaked edge means it may have been lost too).
  containerTest(
    "continueRunIfUnblocked recovers a leaked edge after an interrupted EXECUTING resume",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "guard-le", "run_leake", "sle");
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        // The block installed a heartbeat pointing at the EXECUTING_WITH_WAITPOINTS snapshot.
        const blockedSnapshot = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        const hbBefore = await engine.worker.getJob(`heartbeatSnapshot.${run.id}`);
        expect((hbBefore?.item as { snapshotId?: string })?.snapshotId).toBe(blockedSnapshot.id);

        // Simulate the interrupted resume: waitpoint COMPLETED and the EXECUTING snapshot committed via
        // the STORE (bypassing createExecutionSnapshot), so neither the blocking edge was deleted NOR
        // the heartbeat was re-pointed at the new snapshot — exactly the committed-but-died-early state.
        await prisma.waitpoint.update({
          where: { id: waitpoint.id },
          data: { status: "COMPLETED", completedAt: new Date(), output: "{}" },
        });
        const resumeSnapshotId = SnapshotId.generate().id;
        await engine.runStore.createExecutionSnapshot(
          {
            id: resumeSnapshotId,
            run: {
              id: run.id,
              status: blockedSnapshot.runStatus,
              attemptNumber: blockedSnapshot.attemptNumber,
            },
            snapshot: {
              executionStatus: "EXECUTING",
              description: "resume committed, edge+heartbeat leak",
            },
            previousSnapshotId: blockedSnapshot.id,
            environmentId: env.id,
            environmentType: env.type,
            projectId: env.project.id,
            organizationId: env.organization.id,
          },
          prisma
        );
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);
        // Precondition: the heartbeat is stale (still points at the pre-resume snapshot).
        const hbStale = await engine.worker.getJob(`heartbeatSnapshot.${run.id}`);
        expect((hbStale?.item as { snapshotId?: string })?.snapshotId).toBe(blockedSnapshot.id);

        const notified: string[] = [];
        engine.eventBus.on("workerNotification", (e) => notified.push(e.run.id));

        const result = await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });

        expect(result.status).toBe("unblocked");
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
        expect(notified).toContain(run.id);
        expect(
          (await engine.getRunExecutionData({ runId: run.id }))?.snapshot.executionStatus
        ).toBe("EXECUTING");
        // The stall watchdog was re-installed for the recovered snapshot.
        const hbAfter = await engine.worker.getJob(`heartbeatSnapshot.${run.id}`);
        expect((hbAfter?.item as { snapshotId?: string })?.snapshotId).toBe(resumeSnapshotId);
      } finally {
        await engine.quit();
      }
    }
  );

  // The queue-side variant of the same leak: the run advanced to QUEUED (a SUSPENDED->QUEUED resume)
  // but the edge was never deleted. The re-run must clear it; the lost publish, if any, is recovered
  // by the publish guard, not here.
  containerTest(
    "continueRunIfUnblocked recovers a leaked edge after an interrupted QUEUED resume",
    async ({ prisma, redisOptions }) => {
      const engine = buildEngine(prisma, redisOptions);
      try {
        const env = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
        const run = await triggerExecutingRun(engine, prisma, env, "guard-lq", "run_leakq", "slq");
        const waitpoint = await blockOnWaitpoint(engine, env, run.id);

        await prisma.waitpoint.update({
          where: { id: waitpoint.id },
          data: { status: "COMPLETED", completedAt: new Date(), output: "{}" },
        });
        const latest = await getLatestExecutionSnapshot(prisma, run.id, engine.runStore);
        await engine.executionSnapshotSystem.createExecutionSnapshot(prisma, {
          run: { id: run.id, status: latest.runStatus, attemptNumber: latest.attemptNumber },
          snapshot: { executionStatus: "QUEUED", description: "resume committed, edge leak" },
          previousSnapshotId: latest.id,
          environmentId: env.id,
          environmentType: env.type,
          projectId: env.project.id,
          organizationId: env.organization.id,
        });
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(1);

        const result = await engine.waitpointSystem.continueRunIfUnblocked({ runId: run.id });

        expect(result.status).toBe("unblocked");
        expect(await prisma.taskRunWaitpoint.count({ where: { taskRunId: run.id } })).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
