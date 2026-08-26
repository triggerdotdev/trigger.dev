import { createRedisClient, type RedisOptions } from "@internal/redis";
import { containerTest } from "@internal/testcontainers";
import { getMeter } from "@internal/tracing";
import { Logger } from "@trigger.dev/core/logger";
import { generateRunOpsId, generateWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { PostgresRunStore } from "@internal/run-store";
import { setupAuthenticatedEnvironment } from "../tests/setup.js";
import { runBlockKeys } from "./keys.js";
import { StoreWaitpointCoordinatorArm } from "./storeArm.js";
import { WaitpointStoreCoordinator, type WaitpointRecordInput } from "./storeCoordinator.js";

const RUN_ID = "run_blocked";
const NOW = "2026-08-26T12:00:00.000Z";

function setup(redisOptions: RedisOptions, prisma: PrismaClient) {
  const store = new WaitpointStoreCoordinator({ redisOptions });
  const arm = new StoreWaitpointCoordinatorArm({
    store,
    runStore: new PostgresRunStore({ prisma, readOnlyPrisma: prisma }),
    logger: new Logger("storeArm.test", "error"),
    meter: getMeter("storeArm.test"),
  });

  return { store, arm };
}

function record(
  id: string,
  environmentId: string,
  projectId: string,
  overrides: Partial<WaitpointRecordInput> = {}
): WaitpointRecordInput {
  return {
    id,
    friendlyId: `waitpoint_${id}`,
    type: "MANUAL",
    environmentId,
    projectId,
    createdAt: NOW,
    updatedAt: NOW,
    userProvidedIdempotencyKey: false,
    tags: [],
    idempotencyKey: `idem_${id}`,
    ...overrides,
  };
}

describe("StoreWaitpointCoordinatorArm", () => {
  containerTest(
    "reports COMPLETED once a blocked waitpoint is delivered",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const waitpointId = generateWaitpointId("MANUAL");
        await store.createIfAbsent({
          record: record(waitpointId, environment.id, environment.projectId),
          status: "PENDING",
        });

        const { pendingCount } = await arm.registerBlocks({
          runId: RUN_ID,
          waitpointIds: [waitpointId],
          projectId: environment.projectId,
          client: prisma,
        });
        expect(pendingCount).toBe(1);

        const beforeComplete = await arm.readRunBlockState(RUN_ID);
        expect(beforeComplete[0]!.waitpoint.status).toBe("PENDING");

        await arm.complete({ waitpointId, output: { value: "42", isError: false } });

        const afterComplete = await arm.readRunBlockState(RUN_ID);
        expect(afterComplete).toHaveLength(1);
        expect(afterComplete[0]!.waitpoint.status).toBe("COMPLETED");
        expect(afterComplete[0]!.waitpoint.type).toBe("MANUAL");
      } finally {
        await store.quit();
      }
    }
  );

  // I10, and the only premature-resume counterexample either TLA+ campaign produced. A
  // run-shard loss removes the pending entry while the edge survives; "not pending,
  // therefore complete" would resume a run whose waitpoint never completed.
  containerTest(
    "reports PENDING for an edge that is in neither the pending nor the delivered set",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);
      const redis = createRedisClient(redisOptions);

      try {
        const waitpointId = generateWaitpointId("MANUAL");
        await store.createIfAbsent({
          record: record(waitpointId, environment.id, environment.projectId),
          status: "PENDING",
        });
        await arm.registerBlocks({
          runId: RUN_ID,
          waitpointIds: [waitpointId],
          projectId: environment.projectId,
          client: prisma,
        });

        await redis.srem(runBlockKeys(RUN_ID).pend, waitpointId);

        const edges = await arm.readRunBlockState(RUN_ID);
        expect(edges).toHaveLength(1);
        expect(edges[0]!.waitpoint.status).toBe("PENDING");
      } finally {
        await redis.quit();
        await store.quit();
      }
    }
  );

  // The case a "has a completion envelope" rule would wedge forever: a waitpoint may be
  // COMPLETED with no envelope, which the reported box models on purpose.
  containerTest(
    "reports COMPLETED for a waitpoint completed before the run ever blocked on it",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const waitpointId = generateWaitpointId("MANUAL");
        await store.createIfAbsent({
          record: record(waitpointId, environment.id, environment.projectId),
          status: "COMPLETED",
        });

        const { pendingCount } = await arm.registerBlocks({
          runId: RUN_ID,
          waitpointIds: [waitpointId],
          projectId: environment.projectId,
          client: prisma,
        });

        expect(pendingCount).toBe(0);

        const edges = await arm.readRunBlockState(RUN_ID);
        expect(edges[0]!.waitpoint.status).toBe("COMPLETED");
      } finally {
        await store.quit();
      }
    }
  );

  // §5.4's guard. Unmodeled in both campaigns, so this assertion is its only protection.
  containerTest(
    "refuses a lockless absorb when the parent BATCH waitpoint is absent",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const itemWaitpointId = generateWaitpointId("RUN");
        const batchWaitpointId = generateWaitpointId("BATCH");

        await expect(
          arm.registerBlocksLockless({
            runId: RUN_ID,
            waitpointIds: [itemWaitpointId],
            projectId: environment.projectId,
            batchId: "batch_1",
            batchIndex: 0,
            batchWaitpointId,
          })
        ).rejects.toThrow(/BATCH waitpoint/);
      } finally {
        await store.quit();
      }
    }
  );

  // Present-but-not-pending is the half of the guard a presence-only check would miss.
  containerTest(
    "refuses a lockless absorb when the parent BATCH waitpoint is already complete",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const batchWaitpointId = generateWaitpointId("BATCH");
        await store.createIfAbsent({
          record: record(batchWaitpointId, environment.id, environment.projectId, {
            type: "BATCH",
          }),
          status: "PENDING",
        });
        await arm.registerBlocks({
          runId: RUN_ID,
          waitpointIds: [batchWaitpointId],
          projectId: environment.projectId,
          client: prisma,
        });
        await arm.complete({ waitpointId: batchWaitpointId, output: undefined });

        await expect(
          arm.registerBlocksLockless({
            runId: RUN_ID,
            waitpointIds: [generateWaitpointId("RUN")],
            projectId: environment.projectId,
            batchId: "batch_1",
            batchIndex: 0,
            batchWaitpointId,
          })
        ).rejects.toThrow(/BATCH waitpoint/);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "allows a lockless absorb while the parent BATCH waitpoint is pending",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const batchWaitpointId = generateWaitpointId("BATCH");
        await store.createIfAbsent({
          record: record(batchWaitpointId, environment.id, environment.projectId, {
            type: "BATCH",
          }),
          status: "PENDING",
        });
        await arm.registerBlocks({
          runId: RUN_ID,
          waitpointIds: [batchWaitpointId],
          projectId: environment.projectId,
          client: prisma,
        });

        const itemWaitpointId = generateWaitpointId("RUN");
        await store.createIfAbsent({
          record: record(itemWaitpointId, environment.id, environment.projectId, { type: "RUN" }),
          status: "PENDING",
        });

        await arm.registerBlocksLockless({
          runId: RUN_ID,
          waitpointIds: [itemWaitpointId],
          projectId: environment.projectId,
          batchId: "batch_1",
          batchIndex: 0,
          batchWaitpointId,
        });

        // The parent's BATCH waitpoint is still pending after the item absorbed, which is
        // the invariant: the pending set is never momentarily empty mid-absorb.
        const edges = await arm.readRunBlockState(RUN_ID);
        const stillPending = edges.filter((e) => e.waitpoint.status === "PENDING");
        expect(stillPending.map((e) => e.waitpoint.id).sort()).toEqual(
          [batchWaitpointId, itemWaitpointId].sort()
        );
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "writes the MANUAL projection row after the store commit",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const result = await arm.createManualWaitpoint({
          mintKind: "store",
          environmentId: environment.id,
          projectId: environment.projectId,
          tags: ["alpha"],
        });

        expect(result.kind).toBe("created");

        const row = await prisma.waitpoint.findFirst({ where: { id: result.waitpoint.id } });
        expect(row?.type).toBe("MANUAL");
        expect(row?.tags).toEqual(["alpha"]);

        // The store is the system of record; the row is a projection of it.
        const held = await store.readWaitpoint(result.waitpoint.id);
        expect(held?.status).toBe("PENDING");
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "returns the cached waitpoint for a repeated idempotency key",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const args = {
          mintKind: "store" as const,
          environmentId: environment.id,
          projectId: environment.projectId,
          idempotencyKey: "same-key",
        };

        const first = await arm.createManualWaitpoint(args);
        const second = await arm.createManualWaitpoint(args);

        expect(first.kind).toBe("created");
        expect(second.kind).toBe("cached");
        expect(second.waitpoint.id).toBe(first.waitpoint.id);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "returns null when the batch already has a waitpoint",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const batchId = `batch_${generateRunOpsId()}`;
        const args = {
          batchId,
          environmentId: environment.id,
          projectId: environment.projectId,
          mintKind: "store" as const,
        };

        const first = await arm.createBatchWaitpoint(args);
        expect(first).not.toBeNull();
        expect(first!.type).toBe("BATCH");
        expect(first!.completedByBatchId).toBe(batchId);

        const second = await arm.createBatchWaitpoint(args);
        expect(second).toBeNull();
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "creates the RUN waitpoint at the anchor-derived id, idempotently",
    async ({ prisma, redisOptions }) => {
      const environment = await setupEnvironment(prisma);
      const { store, arm } = setup(redisOptions, prisma);

      try {
        const runId = generateRunOpsId();
        const data = arm.mintAssociatedWaitpointData({
          projectId: environment.projectId,
          environmentId: environment.id,
          anchorRunId: runId,
        });

        // Pure function of the run id, which is what removes the need for a lock.
        expect(data.id.slice(0, 24)).toBe(runId.slice(0, 24));

        const first = await arm.createAssociatedWaitpoint({ runId, data });
        const second = await arm.createAssociatedWaitpoint({ runId, data });

        expect(first.id).toBe(data.id);
        expect(second.id).toBe(data.id);
        expect(second.status).toBe("PENDING");
      } finally {
        await store.quit();
      }
    }
  );
});

async function setupEnvironment(prisma: PrismaClient) {
  const environment = await setupAuthenticatedEnvironment(prisma, "PRODUCTION");
  return { id: environment.id, projectId: environment.project.id };
}
