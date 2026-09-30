import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystem.server";
import { ConcurrencySystem } from "~/v3/services/concurrencySystem.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";

vi.mock("~/v3/runQueue.server", () => ({
  updateQueueConcurrencyLimits: async () => undefined,
  removeQueueConcurrencyLimits: async () => undefined,
  updateQueueTotalConcurrencyLimits: async () => undefined,
  removeQueueTotalConcurrencyLimits: async () => undefined,
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    currentConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    lengthOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    totalConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    gateQueuedCountOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
  },
}));

vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));

vi.mock("~/v3/engineVersion.server", () => ({
  determineEngineVersion: async () => "V2",
}));

vi.setConfig({ testTimeout: 30_000 });

async function seedArchivedQueue(prisma: PrismaClient, name = "emails") {
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
      name,
      orderableName: name,
      type: "NAMED",
      version: "V2",
      concurrencyVersion: "V2",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      concurrencyLimit: 5,
      archivedAt: new Date(),
    },
  });

  const authEnv = {
    id: environment.id,
    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
  } as unknown as AuthenticatedEnvironment;

  return { queue, authEnv };
}

describe("archived queues that get blocked are unarchived", () => {
  postgresTest("pausing an archived queue unarchives it", async ({ prisma }) => {
    const { queue, authEnv } = await seedArchivedQueue(prisma);

    const result = await new PauseQueueService(prisma).call(authEnv, queue.friendlyId, "paused");
    expect(result.success).toBe(true);

    const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
    expect(after.paused).toBe(true);
    expect(after.archivedAt).toBeNull();
  });

  postgresTest("resuming leaves the archive alone", async ({ prisma }) => {
    const { queue, authEnv } = await seedArchivedQueue(prisma);
    await prisma.taskQueue.update({ where: { id: queue.id }, data: { paused: true } });

    const result = await new PauseQueueService(prisma).call(authEnv, queue.friendlyId, "resumed");
    expect(result.success).toBe(true);

    const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
    expect(after.archivedAt).not.toBeNull();
  });

  postgresTest(
    "overriding an archived queue's limit to 0 unarchives it; a nonzero limit doesn't",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedArchivedQueue(prisma);
      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const nonzero = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
        limit: 3,
      });
      expect(nonzero.isOk()).toBe(true);
      const stillArchived = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(stillArchived.archivedAt).not.toBeNull();

      const zero = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
        limit: 0,
      });
      expect(zero.isOk()).toBe(true);
      const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(after.concurrencyLimit).toBe(0);
      expect(after.archivedAt).toBeNull();
    }
  );

  postgresTest(
    "overriding an archived queue's combined limit to 0 unarchives it; a nonzero one doesn't",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedArchivedQueue(prisma);
      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const nonzero = await system.queues.overrideTotalConcurrencyLimit(
        authEnv,
        queue.friendlyId,
        3
      );
      expect(nonzero.isOk()).toBe(true);
      const stillArchived = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(stillArchived.archivedAt).not.toBeNull();

      const zero = await system.queues.overrideTotalConcurrencyLimit(authEnv, queue.friendlyId, 0);
      expect(zero.isOk()).toBe(true);
      const after = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(after.totalConcurrencyLimit).toBe(0);
      expect(after.archivedAt).toBeNull();
    }
  );

  postgresTest(
    "resetting a limit back to a declared 0 unarchives the queue",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedArchivedQueue(prisma);
      await prisma.taskQueue.update({
        where: { id: queue.id },
        data: {
          concurrencyLimitBase: 0,
          concurrencyLimitOverriddenAt: new Date(),
          totalConcurrencyLimit: 5,
          totalConcurrencyLimitBase: 0,
          totalConcurrencyLimitOverriddenAt: new Date(),
        },
      });
      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const perQueue = await system.queues.resetConcurrencyLimit(authEnv, queue.friendlyId);
      expect(perQueue.isOk()).toBe(true);
      const afterPerQueue = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(afterPerQueue.concurrencyLimit).toBe(0);
      expect(afterPerQueue.archivedAt).toBeNull();

      await prisma.taskQueue.update({ where: { id: queue.id }, data: { archivedAt: new Date() } });
      const combined = await system.queues.resetTotalConcurrencyLimit(authEnv, queue.friendlyId);
      expect(combined.isOk()).toBe(true);
      const afterCombined = await prisma.taskQueue.findFirstOrThrow({ where: { id: queue.id } });
      expect(afterCombined.totalConcurrencyLimit).toBe(0);
      expect(afterCombined.archivedAt).toBeNull();
    }
  );

  postgresTest(
    "blocking an archived task queue through the limits API unarchives it",
    async ({ prisma }) => {
      const system = new ConcurrencyLimitsSystem({ db: prisma, reader: prisma });
      const archived = (id: string) =>
        prisma.taskQueue.findFirstOrThrow({ where: { id } }).then((q) => q.archivedAt);

      const paused = await seedArchivedQueue(prisma, "task/emails");
      expect((await system.limits.pause(paused.authEnv, "task/emails")).isOk()).toBe(true);
      expect(await archived(paused.queue.id)).toBeNull();

      const overridden = await seedArchivedQueue(prisma, "task/emails");
      const nonzero = await system.limits.override(overridden.authEnv, "task/emails", { total: 3 });
      expect(nonzero.isOk()).toBe(true);
      expect(await archived(overridden.queue.id)).not.toBeNull();
      const zero = await system.limits.override(overridden.authEnv, "task/emails", { perKey: 0 });
      expect(zero.isOk()).toBe(true);
      expect(await archived(overridden.queue.id)).toBeNull();

      const reset = await seedArchivedQueue(prisma, "task/emails");
      await prisma.taskQueue.update({
        where: { id: reset.queue.id },
        data: { totalConcurrencyLimitBase: 0, totalConcurrencyLimitOverriddenAt: new Date() },
      });
      expect((await system.limits.reset(reset.authEnv, "task/emails")).isOk()).toBe(true);
      expect(await archived(reset.queue.id)).toBeNull();
    }
  );
});
