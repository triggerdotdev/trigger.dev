import { containerTestWithIsolatedRedis as containerTest } from "@internal/testcontainers";
import { describe, expect } from "vitest";
import type { RunEngine } from "../index.js";
import { WaitpointStoreCoordinator } from "../waitpointCoordinator/storeCoordinator.js";
import {
  coordinatorRedis,
  routing,
  seedMixed,
  routingEngine as engine,
} from "../tests/utils/waitpointRouting.js";

async function continuation(engine: RunEngine, runId: string) {
  // Read the production worker's actual durable queue without starting its background consumer.
  const worker = (
    engine as unknown as {
      worker: { getJob(id: string): Promise<{ item: unknown } | undefined> };
    }
  ).worker;
  return worker.getJob(`continueRunIfUnblocked:${runId}`);
}

describe("WaitpointSystem production routing", () => {
  containerTest(
    "disabled cleanup clears real legacy edges with an unavailable store and marker reader",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const instance = engine(prisma, redisOptions, {
        waitpointStore: store,
        waitpointStoreEnabled: () => false,
        waitpointRouting: {
          mightHaveStoreBlockers: async ({ runId }) =>
            (await coordinatorRedis(store).get(runId)) !== null,
        },
      });
      try {
        const { args } = await seedMixed(prisma, store);
        await store.quit();
        const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } });
        await instance.waitpointSystem.cleanupBlockersAfterAttemptFailure({
          runId: args.runId,
          organizationId: run.organizationId!,
          outcome: "terminal",
        });
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
      } finally {
        await instance.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "enabled cleanup forwards run and org to a real scoped marker and releases both stores",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const instance = engine(prisma, redisOptions, {
        waitpointStore: store,
        waitpointStoreEnabled: () => true,
        waitpointRouting: {
          mightHaveStoreBlockers: async ({ runId, organizationId }) =>
            (await coordinatorRedis(store).hget(`test:marker:${organizationId}`, runId)) === "1",
        },
      });
      try {
        const { args } = await seedMixed(prisma, store);
        const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } });
        await coordinatorRedis(store).hset(`test:marker:${run.organizationId!}`, args.runId, "1");
        await instance.waitpointSystem.cleanupBlockersAfterAttemptFailure({
          runId: args.runId,
          organizationId: run.organizationId!,
          outcome: "terminal",
        });
        expect(await prisma.taskRunWaitpoint.count()).toBe(0);
        expect((await store.readBlockState(args.runId)).edges).toEqual([]);
        expect((await store.readBlockState(args.runId)).terminal).toBe(true);
      } finally {
        await instance.quit();
        await store.quit();
      }
    }
  );

  for (const withOrganization of [true, false]) {
    containerTest(
      `disabled completion retains the legacy payload ${withOrganization ? "with caller organization" : "without caller organization"}`,
      async ({ prisma, redisOptions }) => {
        const store = new WaitpointStoreCoordinator({ redisOptions });
        const instance = engine(prisma, redisOptions, {
          waitpointStore: store,
          waitpointStoreEnabled: () => false,
        });
        try {
          const { args, legacyId } = await seedMixed(prisma, store);
          const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } });
          await store.quit();
          await instance.waitpointSystem.completeWaitpoint({
            id: legacyId,
            organizationId: withOrganization ? run.organizationId! : undefined,
          });
          expect((await continuation(instance, args.runId))?.item).toEqual({
            runId: args.runId,
          });
          expect(
            await prisma.waitpoint.findUniqueOrThrow({ where: { id: legacyId } })
          ).toMatchObject({ status: "COMPLETED" });
        } finally {
          await instance.quit();
          await store.quit();
        }
      }
    );
  }

  containerTest(
    "pending legacy continuation skips an unavailable store for both scoped and old payloads",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const instance = engine(prisma, redisOptions, {
        waitpointStore: store,
        waitpointStoreEnabled: () => false,
      });
      try {
        const { args, legacyId } = await seedMixed(prisma, store);
        const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } });
        await store.quit();
        for (const organizationId of [run.organizationId!, undefined]) {
          expect(
            await instance.waitpointSystem.continueRunIfUnblocked({
              runId: args.runId,
              organizationId,
            })
          ).toMatchObject({ status: "blocked", waitpoints: [{ id: legacyId }] });
        }
      } finally {
        await instance.quit();
        await store.quit();
      }
    }
  );

  containerTest(
    "disabled block-and-complete retains the legacy continuation payload",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const instance = engine(prisma, redisOptions, {
        waitpointStore: store,
        waitpointStoreEnabled: () => false,
      });
      try {
        const { args, legacyId } = await seedMixed(prisma, store);
        const run = await prisma.taskRun.findUniqueOrThrow({ where: { id: args.runId } });
        await routing(prisma).clearRunBlockState({ runId: args.runId });
        await store.quit();
        await instance.waitpointSystem.blockRunAndCompleteWaitpoint({
          runId: args.runId,
          waitpointId: legacyId,
          projectId: args.projectId,
          organizationId: run.organizationId!,
          output: { value: "failed", isError: true },
        });
        expect(await prisma.taskRunWaitpoint.count()).toBe(1);
        expect((await continuation(instance, args.runId))?.item).toEqual({ runId: args.runId });
      } finally {
        await instance.quit();
        await store.quit();
      }
    }
  );
  containerTest(
    "terminal associated RUN creation completes its real legacy waitpoint without store access",
    async ({ prisma, redisOptions }) => {
      const store = new WaitpointStoreCoordinator({ redisOptions });
      const instance = engine(prisma, redisOptions, {
        waitpointStore: store,
        waitpointStoreEnabled: () => false,
      });
      try {
        const { args } = await seedMixed(prisma, store);
        await prisma.taskRun.update({
          where: { id: args.runId },
          data: { status: "COMPLETED_SUCCESSFULLY" },
        });
        await prisma.taskRunExecutionSnapshot.updateMany({
          where: { runId: args.runId },
          data: { executionStatus: "FINISHED", runStatus: "COMPLETED_SUCCESSFULLY" },
        });
        await store.quit();
        const waitpoint = await instance.waitpointSystem.getOrCreateRunWaitpoint({
          runId: args.runId,
          projectId: args.projectId,
          environmentId: args.environmentId,
        });
        expect(
          await prisma.waitpoint.findUniqueOrThrow({ where: { id: waitpoint.id } })
        ).toMatchObject({ status: "COMPLETED", type: "RUN" });
      } finally {
        await instance.quit();
        await store.quit();
      }
    }
  );
});
