import type { RedisOptions } from "@internal/redis";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import { BatchId, generateRunOpsId, parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { freshRunFriendlyId, type WaitpointArm } from "./helpers/engineFactory.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

function engineFor(arm: WaitpointArm, prisma: PrismaClient, redisOptions: RedisOptions) {
  return new RunEngine({
    prisma,
    worker: { redis: redisOptions, workers: 1, tasksPerWorker: 10, pollIntervalMs: 100 },
    queue: { redis: redisOptions },
    runLock: { redis: redisOptions },
    waitpointStore: arm === "store" ? { redis: redisOptions } : undefined,
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

function triggerParams(friendlyId: string, environment: any, taskIdentifier: string) {
  return {
    number: 1,
    friendlyId,
    environment,
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
  };
}

async function seedBatch(prisma: PrismaClient, environment: any, arm: WaitpointArm) {
  // Mirrors batchIdForMintKind: a run-ops batch carries a run-ops ROW id, and the BATCH
  // waitpoint derives from that id, not from the friendly id.
  const { id, friendlyId } =
    arm === "store"
      ? (() => {
          const core = generateRunOpsId();
          return { id: core, friendlyId: BatchId.toFriendlyId(core) };
        })()
      : BatchId.generate();

  return prisma.batchTaskRun.create({
    data: { id, friendlyId, runtimeEnvironmentId: environment.id, runCount: 1 },
  });
}

describe.each<WaitpointArm>(["legacy", "store"])("BATCH waitpoint create (%s arm)", (arm) => {
  containerTest(
    "blockRunWithCreatedBatch suspends the parent",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor(arm, prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const parent = await engine.trigger(
          triggerParams(freshRunFriendlyId(arm), environment, taskIdentifier),
          prisma
        );
        const batch = await seedBatch(prisma, environment, arm);

        const waitpoint = await engine.blockRunWithCreatedBatch({
          runId: parent.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
          waitpointMintKind: arm,
        });

        assertNonNullable(waitpoint);
        expect(waitpoint.type).toBe("BATCH");
        expect(waitpoint.completedByBatchId).toBe(batch.id);
        expect(parseWaitpointId(waitpoint.id).format).toBe(arm === "store" ? "b32hexW" : "legacy");

        // A parent that was never blocked stays QUEUED.
        const snapshot = await engine.getRunExecutionData({ runId: parent.id });
        assertNonNullable(snapshot);
        expect(snapshot.snapshot.executionStatus).toBe("SUSPENDED");
      } finally {
        await engine.quit();
      }
    }
  );

  containerTest("a duplicate batch returns null", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = engineFor(arm, prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parent = await engine.trigger(
        triggerParams(freshRunFriendlyId(arm), environment, taskIdentifier),
        prisma
      );
      const batch = await seedBatch(prisma, environment, arm);
      const args = {
        runId: parent.id,
        batchId: batch.id,
        environmentId: environment.id,
        projectId: environment.project.id,
        organizationId: environment.organization.id,
        waitpointMintKind: arm,
      } as const;

      expect(await engine.blockRunWithCreatedBatch(args)).not.toBeNull();
      // The legacy arm reports this through a unique-index violation, the store arm
      // through its create-if-absent. Same contract either way.
      expect(await engine.blockRunWithCreatedBatch(args)).toBeNull();
    } finally {
      await engine.quit();
    }
  });
});

describe("BATCH waitpoint, the lockless absorb guard", () => {
  // The invariant: the parent's BATCH waitpoint holds the pending set open for the whole
  // absorb, so a completion arriving mid-absorb can never see an empty set and resume the
  // parent before its items are registered.
  containerTest(
    "keeps the parent BATCH waitpoint pending while items absorb",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor("store", prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const parent = await engine.trigger(
          triggerParams(freshRunFriendlyId("store"), environment, taskIdentifier),
          prisma
        );
        const batch = await seedBatch(prisma, environment, "store");

        const batchWaitpoint = await engine.blockRunWithCreatedBatch({
          runId: parent.id,
          batchId: batch.id,
          environmentId: environment.id,
          projectId: environment.project.id,
          organizationId: environment.organization.id,
          waitpointMintKind: "store",
        });
        assertNonNullable(batchWaitpoint);

        for (let index = 0; index < 3; index++) {
          await engine.trigger(
            {
              ...triggerParams(freshRunFriendlyId("store"), environment, taskIdentifier),
              parentTaskRunId: parent.id,
              rootTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              depth: 1,
              batch: { id: batch.id, index },
              waitpointMintKind: "store",
            },
            prisma
          );

          // After every item, the parent is still blocked by its BATCH waitpoint.
          const snapshot = await engine.getRunExecutionData({ runId: parent.id });
          assertNonNullable(snapshot);
          expect(snapshot.snapshot.executionStatus).toBe("SUSPENDED");
        }
      } finally {
        await engine.quit();
      }
    }
  );
});
