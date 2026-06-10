import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { describe, expect, vi } from "vitest";
import { setTimeout } from "node:timers/promises";
import { PrismaClient } from "@trigger.dev/database";
import { RedisOptions } from "@internal/redis";
import { RunEngine } from "../index.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function createEngine(prisma: PrismaClient, redisOptions: RedisOptions) {
  return new RunEngine({
    prisma,
    worker: {
      redis: redisOptions,
      workers: 1,
      tasksPerWorker: 10,
      pollIntervalMs: 100,
    },
    queue: {
      redis: redisOptions,
      masterQueueConsumersDisabled: true,
      processWorkerQueueDebounceMs: 50,
    },
    runLock: {
      redis: redisOptions,
    },
    machines: {
      defaultMachine: "small-1x",
      machines: {
        "small-1x": {
          name: "small-1x" as const,
          cpu: 0.5,
          memory: 0.5,
          centsPerMs: 0.0001,
        },
      },
      baseCostInCents: 0.0001,
    },
    tracer: trace.getTracer("test", "0.0.0"),
  });
}

/** Number of xid-consuming (i.e. write) transactions is the delta between two
 * txid_current() calls, minus 1 for the second call itself. Read-only
 * transactions never allocate an xid, so they don't count. */
async function currentTxid(prisma: PrismaClient): Promise<bigint> {
  const rows = await prisma.$queryRaw<{ txid: bigint }[]>`SELECT txid_current() AS txid`;
  return BigInt(rows[0].txid);
}

/** Drives a parent run + triggerAndWait child up to the point where the child
 * is EXECUTING and the parent is blocked on the child's associated waitpoint. */
async function setupBlockedParentWithExecutingChild(
  engine: RunEngine,
  prisma: PrismaClient,
  authenticatedEnvironment: Awaited<ReturnType<typeof setupAuthenticatedEnvironment>>
) {
  const parentTask = "parent-task";
  const childTask = "child-task";

  await setupBackgroundWorker(engine, authenticatedEnvironment, [parentTask, childTask]);

  const parentRun = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_p1234",
      environment: authenticatedEnvironment,
      taskIdentifier: parentTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      queue: `task/${parentTask}`,
      isTest: false,
      tags: [],
      workerQueue: "main",
    },
    prisma
  );

  await setTimeout(500);
  const dequeuedParent = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeuedParent.length).toBe(1);

  await engine.startRunAttempt({
    runId: parentRun.id,
    snapshotId: dequeuedParent[0].snapshot.id,
  });

  const childRun = await engine.trigger(
    {
      number: 1,
      friendlyId: "run_c1234",
      environment: authenticatedEnvironment,
      taskIdentifier: childTask,
      payload: "{}",
      payloadType: "application/json",
      context: {},
      traceContext: {},
      traceId: "t12345",
      spanId: "s12345",
      queue: `task/${childTask}`,
      isTest: false,
      tags: [],
      resumeParentOnCompletion: true,
      parentTaskRunId: parentRun.id,
      workerQueue: "main",
    },
    prisma
  );

  await setTimeout(500);
  const dequeuedChild = await engine.dequeueFromWorkerQueue({
    consumerId: "test_12345",
    workerQueue: "main",
  });
  expect(dequeuedChild.length).toBe(1);

  const childAttempt = await engine.startRunAttempt({
    runId: childRun.id,
    snapshotId: dequeuedChild[0].snapshot.id,
  });

  const childWithWaitpoint = await prisma.taskRun.findFirstOrThrow({
    where: { id: childRun.id },
    include: { associatedWaitpoint: true },
  });
  assertNonNullable(childWithWaitpoint.associatedWaitpoint);

  return {
    parentRun,
    childRun,
    childAttempt,
    waitpointId: childWithWaitpoint.associatedWaitpoint.id,
  };
}

describe("RunEngine atomic completion", () => {
  containerTest(
    "attemptSucceeded with an associated waitpoint is a single write transaction",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { childRun, childAttempt, waitpointId } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        const result = await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            ok: true,
            id: childRun.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        expect(result.attemptStatus).toBe("RUN_FINISHED");

        // Equal xmin on all three rows proves they were written (last-updated)
        // by the same transaction — a timing-window-free proof that the
        // TaskRun update, the FINISHED snapshot insert, and the waitpoint
        // completion all share one commit.
        const rows = await prisma.$queryRaw<{ source: string; xmin: string }[]>`
          SELECT 'run' AS source, xmin::text FROM "TaskRun" WHERE id = ${childRun.id}
          UNION ALL
          SELECT 'snapshot' AS source, xmin::text FROM "TaskRunExecutionSnapshot"
            WHERE "runId" = ${childRun.id} AND "executionStatus"::text = 'FINISHED'
          UNION ALL
          SELECT 'waitpoint' AS source, xmin::text FROM "Waitpoint" WHERE id = ${waitpointId}
        `;
        expect(rows.length, JSON.stringify(rows)).toBe(3);
        expect(new Set(rows.map((r) => r.xmin)).size, JSON.stringify(rows)).toBe(1);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "continueRunIfUnblocked is a single write transaction",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { parentRun, childRun, childAttempt } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        // Take `before` BEFORE completeRunAttempt so the bracket covers both
        // the completion commit and the subsequent continueRunIfUnblocked commit,
        // eliminating the race where the continuation job could commit inside
        // a tighter window taken after completeRunAttempt returns.
        const before = await currentTxid(prisma);

        await engine.completeRunAttempt({
          runId: childRun.id,
          snapshotId: childAttempt.snapshot.id,
          completion: {
            ok: true,
            id: childRun.id,
            output: `{"foo":"bar"}`,
            outputType: "application/json",
          },
        });

        // The continueRunIfUnblocked job is debounced by 50ms; poll until the
        // parent has been continued (EXECUTING_WITH_WAITPOINTS -> EXECUTING).
        let continued = false;
        let lastStatus: string | undefined;
        for (let i = 0; i < 50; i++) {
          await setTimeout(100);
          const parentData = await engine.getRunExecutionData({ runId: parentRun.id });
          lastStatus = parentData?.snapshot.executionStatus;
          if (lastStatus === "EXECUTING") {
            continued = true;
            break;
          }
        }
        expect(continued, `parent never continued, last status: ${lastStatus}`).toBe(true);

        const after = await currentTxid(prisma);

        // completion (1 commit) + continuation (1 commit); today this is 4 (2 + 2).
        // Note: txid_current() is cluster-global — autovacuum could in principle
        // add an xid between the two reads, accepted residual risk; xmin equality
        // cannot witness the TaskRunWaitpoint DELETE so we keep the delta check here.
        const writeTransactions = Number(after - before) - 1;
        expect(writeTransactions).toBe(2);

        const remainingBlockers = await prisma.taskRunWaitpoint.findMany({
          where: { taskRunId: parentRun.id },
        });
        expect(remainingBlockers.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest(
    "a failed completion rolls back the whole transition",
    async ({ prisma, redisOptions }) => {
      const authenticatedEnvironment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = createEngine(prisma, redisOptions);

      try {
        const { childRun, childAttempt, waitpointId } = await setupBlockedParentWithExecutingChild(
          engine,
          prisma,
          authenticatedEnvironment
        );

        // Real fault injection, no mocks: hold a row lock on the child's
        // associated waitpoint so the waitpoint completion inside
        // attemptSucceeded blocks past the transaction timeout (5s default)
        // and the whole transaction aborts.
        // NOTE: this test relies on the implementation's transaction timeout
        // (Prisma default 5s) being well below the 8s lock hold time. If the
        // implementation ever raises its tx timeout to ≥8s, raise the hold
        // time here accordingly.
        const lockHolder = prisma.$transaction(
          async (tx) => {
            await tx.$queryRaw`SELECT "id" FROM "Waitpoint" WHERE "id" = ${waitpointId} FOR UPDATE`;
            await setTimeout(8_000);
          },
          { timeout: 20_000, maxWait: 5_000 }
        );
        await setTimeout(300); // let the lock land

        let completionError: unknown;
        try {
          await engine.completeRunAttempt({
            runId: childRun.id,
            snapshotId: childAttempt.snapshot.id,
            completion: {
              ok: true,
              id: childRun.id,
              output: `{"foo":"bar"}`,
              outputType: "application/json",
            },
          });
        } catch (error) {
          completionError = error;
        }

        await lockHolder;

        // The completion must have failed while the lock was held...
        expect(completionError, "completion must fail while the waitpoint row is locked").toBeDefined();

        // ...and NOTHING from the transition may have been committed:
        // run still EXECUTING, waitpoint still PENDING, no FINISHED snapshot.
        const childAfter = await prisma.taskRun.findFirstOrThrow({
          where: { id: childRun.id },
        });
        expect(childAfter.status).toBe("EXECUTING");

        const waitpointAfter = await prisma.waitpoint.findFirstOrThrow({
          where: { id: waitpointId },
        });
        expect(waitpointAfter.status).toBe("PENDING");

        const finishedSnapshots = await prisma.taskRunExecutionSnapshot.findMany({
          where: { runId: childRun.id, executionStatus: "FINISHED" },
        });
        expect(finishedSnapshots.length).toBe(0);
      } finally {
        await engine.quit();
      }
    }
  );
});
