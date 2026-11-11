import { createRedisClient } from "@internal/redis";
import { containerTest } from "@internal/testcontainers";
import { generateWaitpointId, parseWaitpointId } from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import { StoreWaitpointRegistrationUnsupported } from "../errors.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import { coordinatorRedis, routing, context, keys } from "../tests/utils/waitpointRouting.js";

describe("RoutingWaitpointCoordinator with production Postgres and Redis coordinators", () => {
  containerTest(
    "disabled default creates and completes real Postgres waitpoints without store keys",
    async ({ prisma, redisOptions }) => {
      const params = await context(prisma);
      const coordinator = routing(prisma);
      const probe = createRedisClient(redisOptions);
      try {
        await probe.set("wp:v1:positive-control", "present");
        const date = await coordinator.createDateTimeWaitpoint(params);
        const manual = await coordinator.createManualWaitpoint(params);
        await coordinator.complete({ waitpointId: date.waitpoint.id });
        expect(
          await prisma.waitpoint.findUniqueOrThrow({ where: { id: date.waitpoint.id } })
        ).toMatchObject({ status: "COMPLETED" });
        expect(
          await prisma.waitpoint.findUniqueOrThrow({ where: { id: manual.waitpoint.id } })
        ).toMatchObject({ status: "PENDING" });
        expect(await keys(redisOptions)).toEqual(["wp:v1:positive-control"]);
      } finally {
        await probe.quit();
      }
    }
  );

  containerTest(
    "rollback changes new mints while existing store ids still complete only in Redis",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      let mode: "redis" | "legacy" = "redis";
      const coordinator = routing(prisma, store, {
        mintPolicy: { resolveMintMode: () => mode, isCapabilityReady: () => true },
      });
      try {
        const params = await context(prisma);
        const stored = await coordinator.createDateTimeWaitpoint(params);
        expect(parseWaitpointId(stored.waitpoint.id).format).toBe("b32hexW");
        expect(await keys(redisOptions)).toContain(`wp:v1:{${stored.waitpoint.id}}`);
        expect(await prisma.waitpoint.count()).toBe(0);
        mode = "legacy";
        const legacy = await coordinator.createDateTimeWaitpoint(params);
        expect(parseWaitpointId(legacy.waitpoint.id).format).toBe("legacy");
        await coordinator.complete({ waitpointId: stored.waitpoint.id });
        expect(
          (await store.readCompletedRecords([stored.waitpoint.id])).get(stored.waitpoint.id)?.status
        ).toBe("COMPLETED");
        expect(await prisma.waitpoint.findMany({ select: { id: true, status: true } })).toEqual([
          { id: legacy.waitpoint.id, status: "PENDING" },
        ]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "real store mint and completion connection failures never create Postgres replacements",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const coordinator = routing(prisma, store);
      try {
        const params = await context(prisma);
        const stored = await coordinator.createDateTimeWaitpoint(params);
        await store.quit();
        await expect(coordinator.createDateTimeWaitpoint(params)).rejects.toThrow();
        await expect(coordinator.complete({ waitpointId: stored.waitpoint.id })).rejects.toThrow();
        expect(await prisma.waitpoint.count()).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "store and mixed registration refuse the single-call seam before either store writes",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const coordinator = routing(prisma, store);
      try {
        const params = await context(prisma);
        const legacy = await routing(prisma).createDateTimeWaitpoint(params);
        const storeId = generateWaitpointId("DATETIME");
        for (const waitpointIds of [[storeId], [legacy.waitpoint.id, storeId]]) {
          await expect(
            coordinator.registerBlocks({
              runId: "run_barrier",
              waitpointIds,
              projectId: params.projectId,
              client: prisma,
              parentResidency: "redis-primary",
            })
          ).rejects.toBeInstanceOf(StoreWaitpointRegistrationUnsupported);
        }
        expect(await keys(redisOptions, "wp:v1:run:*")).toEqual([]);
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "disabled run reads and clears succeed with a closed store and closed marker reader",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const coordinator = routing(prisma, store, {
        isStoreEnabled: () => false,
        mightHaveStoreBlockers: async () =>
          (await coordinatorRedis(store).get("disabled-marker")) !== null,
      });
      try {
        await store.quit();
        expect(await coordinator.readRunBlockState("run_never_enabled")).toEqual([]);
        expect(await coordinator.clearRunBlockState({ runId: "run_never_enabled" })).toEqual({
          count: 0,
        });
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "run reads expose real store edges and clear removes the actual pending state",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const coordinator = routing(prisma, store);
      try {
        const blocker = generateWaitpointId("DATETIME");
        await store.absorbBlockers({
          runId: "run_ever_enabled",
          blockId: "blk_1",
          edges: [{ waitpointId: blocker, type: "DATETIME", createdAt: new Date().toISOString() }],
        });
        expect(
          (await coordinator.readRunBlockState("run_ever_enabled")).map((edge) => edge.waitpoint.id)
        ).toEqual([blocker]);
        expect(await coordinator.clearRunBlockState({ runId: "run_ever_enabled" })).toEqual({
          count: 1,
        });
        expect((await store.readBlockState("run_ever_enabled")).pendingIds).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );
});
