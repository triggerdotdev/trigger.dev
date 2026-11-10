import { containerTest, postgresTest } from "@internal/testcontainers";
import {
  generateRunOpsId,
  generateWaitpointId,
  parseWaitpointId,
  WaitpointId,
} from "@trigger.dev/core/v3/isomorphic";
import { describe, expect } from "vitest";
import {
  StoreWaitpointRegistrationUnsupported,
  TransactionalStoreClearUnsupported,
} from "../errors.js";
import { StoreWaitpointCoordinator } from "./storeWaitpointCoordinator.js";
import { WaitpointStoreCoordinator } from "./storeCoordinator.js";
import {
  coordinatorRedis,
  context,
  routing,
  parent,
  blockers,
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
    "both registration seams refuse store blockers on every parent route before legacy writes",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args, legacyId, storeId } = await blockers(prisma, store);
        const coordinator = routing(prisma, store);
        for (const parentResidency of [
          "postgres",
          "mirrored",
          "redis-primary",
          undefined,
        ] as const) {
          const request = { ...args, parentResidency, waitpointIds: [legacyId, storeId] };
          await expect(coordinator.registerBlocks(request)).rejects.toBeInstanceOf(
            StoreWaitpointRegistrationUnsupported
          );
          await expect(coordinator.registerBlocksLockless(request)).rejects.toBeInstanceOf(
            StoreWaitpointRegistrationUnsupported
          );
        }
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "default discovery unions real edges and nontransactional clear drains both stores",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args, legacyId, storeId } = await seedMixed(prisma, store);
        const coordinator = routing(prisma, store);
        expect(
          (await coordinator.readRunBlockState(args.runId)).map((edge) => edge.waitpoint.id).sort()
        ).toEqual([legacyId, storeId].sort());
        expect(await coordinator.clearRunBlockState({ runId: args.runId })).toEqual({ count: 2 });
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "an unavailable real marker reader falls back conservatively to both stores",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const markerReader = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args, legacyId, storeId } = await seedMixed(prisma, store);
        await markerReader.quit();
        const coordinator = routing(prisma, store, {
          mightHaveStoreBlockers: async ({ runId }) =>
            (await coordinatorRedis(markerReader).get(runId)) !== null,
        });
        expect(
          (await coordinator.readRunBlockState(args.runId)).map((edge) => edge.waitpoint.id).sort()
        ).toEqual([legacyId, storeId].sort());
        await coordinator.clearRunBlockState({ runId: args.runId });
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
      } finally {
        await markerReader.quit();
        await store.quit();
      }
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
    "transactional mixed clear refuses before mutation and legacy-only clear participates in rollback",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args } = await seedMixed(prisma, store);
        const coordinator = routing(prisma, store);
        await prisma.$transaction(async (tx) => {
          await expect(
            coordinator.clearRunBlockState({ runId: args.runId, tx })
          ).rejects.toBeInstanceOf(TransactionalStoreClearUnsupported);
        });
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
        expect((await store.readBlockState(args.runId)).edges).toHaveLength(1);
        // Catches: a legacy-only clear not deleting the run's edges inside the caller's transaction.
        await expect(
          prisma.$transaction(async (tx) => {
            await routing(prisma).clearRunBlockState({ runId: args.runId, tx });
            expect(await tx.taskRunWaitpoint.count()).toBe(0);
            await tx.taskRun.findUniqueOrThrow({ where: { id: "missing-lifecycle-run" } });
          })
        ).rejects.toMatchObject({ code: "P2025" });
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
        expect((await store.readBlockState(args.runId)).edges).toHaveLength(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "refused store CAS leaves existing store cycle and legacy edges unchanged",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args, legacyId, storeId } = await seedMixed(prisma, store);
        const before = await store.readBlockState(args.runId);
        // Catches: a stale store CAS refusal surfacing as a terminal outcome.
        await expect(
          routing(prisma, store).absorbBlockers({
            ...args,
            waitpointIds: [legacyId, storeId],
            blockId: "stale-block",
            absorptionId: "stale-absorption",
          })
        ).rejects.toMatchObject({ name: "StoreWaitpointBlockRefusedError", outcome: "stale" });
        expect(await store.readBlockState(args.runId)).toEqual(before);
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "real legacy FK failure compensates only the newly accepted store absorption",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args, storeId } = await blockers(prisma, store);
        const retained = await new StoreWaitpointCoordinator({ store }).createDateTimeWaitpoint({
          ...args,
          completedAfter: new Date(),
        });
        const adapter = new StoreWaitpointCoordinator({ store });
        await adapter.absorbBlockers({
          ...args,
          blockId: "block",
          absorptionId: "retained",
          waitpointIds: [retained.waitpoint.id],
        });
        // Catches: the legacy FK error being replaced while compensating the store absorption.
        await expect(
          routing(prisma, store).absorbBlockers({
            ...args,
            blockId: "block",
            absorptionId: "failed",
            waitpointIds: [storeId, WaitpointId.generate().id],
          })
        ).rejects.toMatchObject({ code: "P2010", meta: { code: "23503" } });
        expect((await store.readBlockState(args.runId)).pendingIds).toEqual([
          retained.waitpoint.id,
        ]);
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
      } finally {
        await store.quit();
      }
    }
  );

  containerTest(
    "retained store withdrawal and legacy pretransition clear preserve the other store's current edges",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      try {
        const { args } = await seedMixed(prisma, store);
        const coordinator = routing(prisma, store);
        await coordinator.resumeRetainedWithdrawal({ runId: args.runId, blockId: "old-block" });
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
        const before = await store.readBlockState(args.runId);
        await prisma.$transaction(async (tx) => {
          await coordinator.clearLegacyBlockersBeforeTransition({ runId: args.runId, tx });
        });
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect(await store.readBlockState(args.runId)).toEqual(before);
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
    "a real connection failure during compensation surfaces the fenced absorption identity",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const observer = new WaitpointStoreCoordinator({ redisOptions });
      let release!: () => void;
      let entered!: () => void;
      const unlocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const locked = new Promise<void>((resolve) => {
        entered = resolve;
      });
      let holder: Promise<unknown> | undefined;
      try {
        const { args, storeId } = await blockers(prisma, store);
        holder = prisma.$transaction(
          async (tx) => {
            await tx.$executeRawUnsafe("SET LOCAL lock_timeout = '2s'");
            await tx.$executeRawUnsafe('LOCK TABLE "TaskRunWaitpoint" IN ACCESS EXCLUSIVE MODE');
            entered();
            let deadline: ReturnType<typeof setTimeout> | undefined;
            try {
              await Promise.race([
                unlocked,
                new Promise((_, reject) => {
                  deadline = setTimeout(
                    () => reject(new Error("compensation test SQL gate was never released")),
                    5_000
                  );
                }),
              ]);
            } finally {
              clearTimeout(deadline);
            }
          },
          { timeout: 10_000 }
        );
        await Promise.race([locked, holder]);
        const failed = expect(
          routing(prisma, store).absorbBlockers({
            ...args,
            waitpointIds: [storeId, WaitpointId.generate().id],
            blockId: "failed-block",
            absorptionId: "failed-absorption",
          })
        ).rejects.toMatchObject({
          name: "StoreAbsorptionCompensationFailed",
          runId: args.runId,
          blockId: "failed-block",
          absorptionId: "failed-absorption",
        });
        await expect
          .poll(async () => (await observer.readBlockState(args.runId)).pendingIds, {
            timeout: 3_000,
            interval: 10,
            message: "store absorption never committed before the blocked Postgres insert",
          })
          .toEqual([storeId]);
        await store.quit();
        release();
        await holder;
        await failed;
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect((await observer.readBlockState(args.runId)).pendingIds).toEqual([storeId]);
      } finally {
        release();
        await holder;
        await observer.quit();
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
