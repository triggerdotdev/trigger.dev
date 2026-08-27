import { createRedisClient, type RedisOptions } from "@internal/redis";
import { assertNonNullable, containerTest } from "@internal/testcontainers";
import { trace } from "@internal/tracing";
import {
  generateRunOpsId,
  parseWaitpointId,
  RunId,
  deriveWaitpointIdFromAnchor,
} from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { RunEngine } from "../index.js";
import { waitpointKeys } from "../waitpointCoordinator/keys.js";
import { setupAuthenticatedEnvironment, setupBackgroundWorker } from "./setup.js";

vi.setConfig({ testTimeout: 60_000 });

type Arm = "legacy" | "store";

function engineFor(arm: Arm, prisma: PrismaClient, redisOptions: RedisOptions) {
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

/**
 * A store RUN waitpoint derives its id from the anchor run's own id body, so a store-arm
 * run has to be triggered with a run-ops friendly id. A legacy-shaped run in a flipped
 * organization keeps a legacy waitpoint, which is a case worth its own test below.
 */
function freshRunFriendlyId(arm: Arm) {
  return arm === "store" ? RunId.toFriendlyId(generateRunOpsId()) : RunId.generate().friendlyId;
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

describe.each<Arm>(["legacy", "store"])("trigger-time RUN waitpoint (%s arm)", (arm) => {
  containerTest("triggerAndWait suspends the parent", async ({ prisma, redisOptions }) => {
    const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
    const engine = engineFor(arm, prisma, redisOptions);

    try {
      const taskIdentifier = "test-task";
      await setupBackgroundWorker(engine, environment, taskIdentifier);

      const parent = await engine.trigger(
        triggerParams(freshRunFriendlyId(arm), environment, taskIdentifier),
        prisma
      );

      await engine.trigger(
        {
          ...triggerParams(freshRunFriendlyId(arm), environment, taskIdentifier),
          parentTaskRunId: parent.id,
          rootTaskRunId: parent.id,
          resumeParentOnCompletion: true,
          depth: 1,
          waitpointMintKind: arm,
        },
        prisma
      );

      // A parent that was never blocked stays QUEUED, so QUEUED must NOT be acceptable
      // here. This is the assertion that catches the block step being skipped entirely.
      const snapshot = await engine.getRunExecutionData({ runId: parent.id });
      assertNonNullable(snapshot);
      expect(snapshot.snapshot.executionStatus).toBe("SUSPENDED");
    } finally {
      await engine.quit();
    }
  });
});

describe("trigger-time RUN waitpoint, store specifics", () => {
  containerTest(
    "derives the waitpoint id from the child run's id",
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
        const childFriendlyId = freshRunFriendlyId("store");
        const child = await engine.trigger(
          {
            ...triggerParams(childFriendlyId, environment, taskIdentifier),
            parentTaskRunId: parent.id,
            rootTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            depth: 1,
            waitpointMintKind: "store",
          },
          prisma
        );

        const expected = deriveWaitpointIdFromAnchor(child.id, "RUN");
        assertNonNullable(expected);
        expect(parseWaitpointId(expected).format).toBe("b32hexW");

        // No Postgres row: the store owns this waitpoint entirely.
        const row = await prisma.waitpoint.findFirst({ where: { id: expected } });
        expect(row).toBeNull();
      } finally {
        await engine.quit();
      }
    }
  );

  // The Frozen-list rule: a crash between the run commit and the waitpoint create must fail
  // loud at the parent's register step, never resume the parent as though nothing was owed.
  containerTest(
    "fails loud when the store waitpoint is missing at register",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor("store", prisma, redisOptions);
      const redis = createRedisClient(redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const parent = await engine.trigger(
          triggerParams(freshRunFriendlyId("store"), environment, taskIdentifier),
          prisma
        );

        const childFriendlyId = freshRunFriendlyId("store");
        const childId = RunId.fromFriendlyId(childFriendlyId);
        const waitpointId = deriveWaitpointIdFromAnchor(childId, "RUN");
        assertNonNullable(waitpointId);

        // Stand in for the crash: the run commits, the waitpoint never reaches the store.
        // Deleting the record before the parent registers reproduces that window exactly.
        const failing = engine
          .trigger(
            {
              ...triggerParams(childFriendlyId, environment, taskIdentifier),
              parentTaskRunId: parent.id,
              rootTaskRunId: parent.id,
              resumeParentOnCompletion: true,
              depth: 1,
              waitpointMintKind: "store",
            },
            prisma
          )
          .then(async (run) => {
            await redis.del(waitpointKeys(waitpointId).record);
            await engine.blockRunWithWaitpoint({
              runId: parent.id,
              waitpoints: waitpointId,
              projectId: environment.project.id,
              organizationId: environment.organization.id,
            });
            return run;
          });

        await expect(failing).rejects.toThrow();
      } finally {
        await redis.quit();
        await engine.quit();
      }
    }
  );

  // Coexistence: a flipped organization still on legacy run ids keeps legacy waitpoints,
  // because the derivation needs a run-ops anchor to work from.
  containerTest(
    "keeps a legacy waitpoint when the run id is legacy shaped",
    async ({ prisma, redisOptions }) => {
      const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
      const engine = engineFor("store", prisma, redisOptions);

      try {
        const taskIdentifier = "test-task";
        await setupBackgroundWorker(engine, environment, taskIdentifier);

        const parent = await engine.trigger(
          triggerParams(freshRunFriendlyId("legacy"), environment, taskIdentifier),
          prisma
        );
        const child = await engine.trigger(
          {
            ...triggerParams(freshRunFriendlyId("legacy"), environment, taskIdentifier),
            parentTaskRunId: parent.id,
            rootTaskRunId: parent.id,
            resumeParentOnCompletion: true,
            depth: 1,
            waitpointMintKind: "store",
          },
          prisma
        );

        const row = await prisma.waitpoint.findFirst({ where: { completedByTaskRunId: child.id } });
        assertNonNullable(row);
        expect(parseWaitpointId(row.id).format).toBe("legacy");
      } finally {
        await engine.quit();
      }
    }
  );
});
