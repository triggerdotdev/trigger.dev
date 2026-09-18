import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { beforeEach, describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencySystem } from "~/v3/services/concurrencySystem.server";

/**
 * The reset flow syncs the engine to the declared base BEFORE its guarded DB write, so
 * a concurrent override landing between the reset's read and its write both trips the
 * optimistic guard AND leaves the reset's stale engine write behind. The mocked sync is
 * the injection point: performing the concurrent override inside the enforce-first sync
 * makes the race deterministic, and the assertions pin the heal that must follow.
 */
const { totalSyncMock, totalRemoveMock } = vi.hoisted(() => ({
  totalSyncMock: vi.fn(async (..._args: unknown[]) => undefined),
  totalRemoveMock: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    lengthOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    currentConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    runQueue: {
      updateQueueConcurrencyLimits: async () => undefined,
      removeQueueConcurrencyLimits: async () => undefined,
      updateQueueTotalConcurrencyLimits: totalSyncMock,
      removeQueueTotalConcurrencyLimits: totalRemoveMock,
      updateEnvConcurrencyLimits: async () => undefined,
    },
  },
}));

vi.setConfig({ testTimeout: 30_000 });

async function seedOverriddenQueue(prisma: PrismaClient) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug,
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: slug,
      pkApiKey: slug,
      shortcode: slug,
      maximumConcurrencyLimit: 100,
    },
  });
  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${slug}`,
      name: "my-queue",
      type: "NAMED",
      version: "V2",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      totalConcurrencyLimit: 10,
      totalConcurrencyLimitBase: 5,
      totalConcurrencyLimitOverriddenAt: new Date(),
    },
  });

  const authEnv = {
    id: environment.id,
    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
  } as unknown as AuthenticatedEnvironment;
  const system = new ConcurrencySystem({ db: prisma, reader: prisma });

  return { queue, authEnv, system };
}

describe("total-limit reset losing to a concurrent override", () => {
  beforeEach(() => {
    totalSyncMock.mockReset();
    totalRemoveMock.mockReset();
  });

  postgresTest(
    "returns a conflict and re-syncs the engine from the winning row",
    async ({ prisma }) => {
      const { queue, authEnv, system } = await seedOverriddenQueue(prisma);

      /** The enforce-first sync (base = 5) is where the concurrent override lands: it moves
       * the marker so the reset's guarded write misses, and its own engine sync never runs
       * (the winner's sync failing is the case that makes healing load-bearing). */
      totalSyncMock
        .mockImplementationOnce(async () => {
          await prisma.taskQueue.update({
            where: { id: queue.id },
            data: {
              totalConcurrencyLimit: 20,
              totalConcurrencyLimitBase: 5,
              totalConcurrencyLimitOverriddenAt: new Date(),
            },
          });
        })
        /** A THIRD writer landing while the heal's own engine write is in flight: the
         * heal's convergence loop must re-read and re-apply it, so its stale write can
         * never be the last one standing. */
        .mockImplementationOnce(async () => {
          await prisma.taskQueue.update({
            where: { id: queue.id },
            data: {
              totalConcurrencyLimit: 7,
              totalConcurrencyLimitBase: 5,
              totalConcurrencyLimitOverriddenAt: new Date(),
            },
          });
        });

      const result = await system.queues.resetTotalConcurrencyLimit(authEnv, queue.friendlyId);

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("concurrent_modification");
      }

      const row = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(row.totalConcurrencyLimit).toBe(7);
      expect(row.totalConcurrencyLimitOverriddenAt).not.toBeNull();

      /** Call 1 is the reset's enforce-first write of the stale base (5); the heal follows
       * with 20 (already stale by the time it lands) and must then converge on 7, the
       * persisted winner, as the LAST engine write. */
      const syncedValues = totalSyncMock.mock.calls.map((call) => call[2]);
      expect(syncedValues[0]).toBe(5);
      expect(syncedValues).toContain(20);
      expect(syncedValues[syncedValues.length - 1]).toBe(7);
      expect(totalRemoveMock).not.toHaveBeenCalled();
    }
  );
});
