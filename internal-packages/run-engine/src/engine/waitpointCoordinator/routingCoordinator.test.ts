import { containerTest, postgresTest } from "@internal/testcontainers";
import {
  generateRunOpsId,
  generateWaitpointId,
  parseWaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";

import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import {
  coordinatorRedis,
  context,
  routing,
  parent,
  seedMixed,
} from "../tests/utils/waitpointRouting.js";

describe("RoutingWaitpointCoordinator persisted boundaries", () => {
  postgresTest(
    "a store id without a store fails before creating any Postgres state",
    async ({ prisma }) => {
      await expect(
        routing(prisma).complete({ waitpointId: generateWaitpointId("DATETIME") })
      ).rejects.toThrow();
      expect(await prisma.waitpoint.count()).toBe(0);
    }
  );

  containerTest(
    "mint gates preserve legacy residency for absent context, unavailable capability and narrowed eligibility",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const params = await context(prisma);
        const enabled = routing(prisma, store);
        const withoutContext = await enabled.createDateTimeWaitpoint({
          ...params,
          mintContext: undefined,
        });
        const notReady = await routing(prisma, store, {
          mintPolicy: { resolveMintMode: () => "redis", isCapabilityReady: () => false },
        }).createDateTimeWaitpoint(params);
        const narrowed = await enabled.createManualWaitpoint({
          ...params,
          mintContext: { ...params.mintContext, eligibleTypes: new Set(["RUN"]) },
        });
        for (const result of [withoutContext, notReady, narrowed])
          expect(parseWaitpointId(result.waitpoint.id).format).toBe("legacy");
        expect(await prisma.waitpoint.count()).toBe(3);
        expect(await coordinatorRedis(store).keys("wp:v1:*")).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "associated RUN planning ignores snapshot residency and defaults to legacy without context",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const coordinator = routing(prisma, store);
        const params = { ...(await context(prisma)), anchorRunId: generateRunOpsId() };
        const enabled = await coordinator.planAssociatedWaitpoint(params);
        const postgres = await coordinator.planAssociatedWaitpoint({
          ...params,
          mintContext: { ...params.mintContext, parentResidency: "postgres" },
        });
        const absent = await coordinator.planAssociatedWaitpoint({
          ...params,
          mintContext: undefined,
        });
        expect(enabled.residency).toBe("store");
        expect(parseWaitpointId(enabled.data.id).format).toBe("b32hexW");
        expect(postgres.residency).toBe("store");
        expect(postgres.data.id).toBe(enabled.data.id);
        expect(absent.residency).toBe("legacy");
        expect(parseWaitpointId(absent.data.id).format).toBe("legacy");
      } finally {
        await store.quit();
      }
    }
  );

  postgresTest(
    "legacy registration, completion, read and lockless indexed registration persist their real effects",
    async ({ prisma }) => {
      const args = await parent(prisma);
      const coordinator = routing(prisma);
      const blocker = await coordinator.createDateTimeWaitpoint({
        ...args,
        completedAfter: new Date(),
      });
      expect(
        await coordinator.registerBlocks({
          ...args,
          waitpointIds: [blocker.waitpoint.id, blocker.waitpoint.id],
        })
      ).toEqual({ pendingCount: 1 });
      expect(await prisma.taskRunWaitpoint.count()).toBe(2);
      const completed = await coordinator.complete({ waitpointId: blocker.waitpoint.id });
      expect(completed.blockedRuns.map((run) => run.taskRunId)).toEqual([args.runId, args.runId]);
      expect((await coordinator.readRunBlockState(args.runId))[0]?.waitpoint.status).toBe(
        "COMPLETED"
      );
      await coordinator.clearRunBlockState({ runId: args.runId });
      await coordinator.registerBlocksLockless({
        ...args,
        waitpointIds: [blocker.waitpoint.id],
        batchIndex: 4,
      });
      expect(await prisma.taskRunWaitpoint.findMany({ select: { batchIndex: true } })).toEqual([
        { batchIndex: 4 },
      ]);
    }
  );

  containerTest(
    "marker lookup receives run and organization and skips a closed store for an unmarked run",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const args = await parent(prisma);
        const organizationId = (
          await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } })
        ).organizationId!;
        await store.quit();
        // A real scoped marker: the fixture's run is in this org, so its presence selects legacy-only.
        const coordinator = routing(prisma, store, {
          mightHaveStoreBlockers: async ({ runId, organizationId }) => {
            const organization = await prisma.organization.findUniqueOrThrow({
              where: { id: organizationId ?? "" },
            });
            return !(await prisma.taskRun.findFirst({
              where: { id: runId, organizationId: organization.id },
            }));
          },
        });
        expect(await coordinator.readRunBlockState(args.runId, { organizationId })).toEqual([]);
        expect(await coordinator.clearRunBlockState({ runId: args.runId, organizationId })).toEqual(
          { count: 0 }
        );
        expect(
          await coordinator.findAssociatedRunWaitpointId(args.runId, { organizationId })
        ).toBeUndefined();
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "rollback still discovers the real store RUN association",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const params = await context(prisma);
        const runId = generateRunOpsId();
        const adapter = new StoreWaitpointCoordinator({ store });
        const data = adapter.mintAssociatedWaitpointData({ ...params, anchorRunId: runId });
        await adapter.createAssociatedWaitpoint({ runId, data });
        const coordinator = routing(prisma, store, {
          mintPolicy: { resolveMintMode: () => "legacy", isCapabilityReady: () => true },
        });
        expect(await coordinator.findAssociatedRunWaitpointId(runId)).toBe(data.id);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "legacy delete failure leaves store blockers active until cleanup retries successfully",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args } = await seedMixed(prisma, store);
        const coordinator = routing(prisma, store);
        const before = await store.readBlockState(args.runId);
        await prisma.$executeRawUnsafe(
          `CREATE FUNCTION refuse_test_edge_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test edge delete constraint'; END $$`
        );
        await prisma.$executeRawUnsafe(
          `CREATE TRIGGER refuse_test_edge_delete BEFORE DELETE ON "TaskRunWaitpoint" FOR EACH ROW EXECUTE FUNCTION refuse_test_edge_delete()`
        );
        await expect(coordinator.abandonRunBlockers({ runId: args.runId })).rejects.toThrow(
          "test edge delete constraint"
        );
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
        expect(await store.readBlockState(args.runId)).toEqual(before);
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER refuse_test_edge_delete ON "TaskRunWaitpoint"'
        );
        await coordinator.abandonRunBlockers({ runId: args.runId });
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );
});
