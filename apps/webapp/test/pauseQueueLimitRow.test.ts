import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { beforeEach, describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencySystem } from "~/v3/services/concurrencySystem.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";

/**
 * The dashboard's limit rows submit the shared queue-pause/queue-resume actions,
 * so PauseQueueService must resolve LIMIT rows (the widened-roles path) and its
 * engine writes must hold for them: pause writes per-key 0, resume restores the
 * stored value, and the total key is never touched.
 */
const { perKeySyncMock, perKeyRemoveMock, totalSyncMock, totalRemoveMock } = vi.hoisted(() => ({
  perKeySyncMock: vi.fn(async (..._args: unknown[]) => undefined),
  perKeyRemoveMock: vi.fn(async (..._args: unknown[]) => undefined),
  totalSyncMock: vi.fn(async (..._args: unknown[]) => undefined),
  totalRemoveMock: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("~/v3/runQueue.server", () => ({
  updateQueueConcurrencyLimits: perKeySyncMock,
  removeQueueConcurrencyLimits: perKeyRemoveMock,
  updateQueueTotalConcurrencyLimits: totalSyncMock,
  removeQueueTotalConcurrencyLimits: totalRemoveMock,
}));

/**
 * Every count source returns a distinct value so an assertion on the response's
 * running/queued proves which source was read: LIMIT rows must report the gate
 * machinery's counts, never the per-queue keys (always empty for a gate).
 */
const GATE_RUNNING = 7;
const GATE_QUEUED = 11;
const QUEUE_RUNNING = 3;
const QUEUE_QUEUED = 4;

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    currentConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, QUEUE_RUNNING])),
    lengthOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, QUEUE_QUEUED])),
    totalConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, GATE_RUNNING])),
    gateQueuedCountOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, GATE_QUEUED])),
  },
}));

vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));

vi.mock("~/v3/engineVersion.server", () => ({
  determineEngineVersion: async () => "V2",
}));

vi.setConfig({ testTimeout: 30_000 });

async function seedEnvAndLimitRow(prisma: PrismaClient) {
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

  const row = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${slug}`,
      name: "limit/openai",
      orderableName: "openai",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      role: "LIMIT",
      concurrencyVersion: "V2",
      concurrencyLimit: 5,
      totalConcurrencyLimit: 25,
    },
  });

  const authEnv = {
    id: environment.id,
    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
  } as unknown as AuthenticatedEnvironment;

  return { row, authEnv };
}

describe("PauseQueueService with a LIMIT row", () => {
  beforeEach(() => {
    perKeySyncMock.mockReset();
    perKeyRemoveMock.mockReset();
    totalSyncMock.mockReset();
    totalRemoveMock.mockReset();
  });

  postgresTest("pauses and resumes a named concurrency limit row", async ({ prisma }) => {
    const { row, authEnv } = await seedEnvAndLimitRow(prisma);
    const service = new PauseQueueService(prisma);

    const paused = await service.call(authEnv, row.friendlyId, "paused", {
      roles: ["QUEUE", "LIMIT"],
    });
    expect(paused.success).toBe(true);
    if (paused.success) {
      expect(paused.queue.paused).toBe(true);
      expect(paused.queue.running).toBe(GATE_RUNNING);
      expect(paused.queue.queued).toBe(GATE_QUEUED);
    }

    const pausedRow = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
    expect(pausedRow.paused).toBe(true);
    /** The configured bounds stay intact; only the per-key engine key drops to 0. */
    expect(pausedRow.concurrencyLimit).toBe(5);
    expect(pausedRow.totalConcurrencyLimit).toBe(25);
    expect(perKeySyncMock).toHaveBeenCalledWith(authEnv, "limit/openai", 0);
    expect(totalSyncMock).not.toHaveBeenCalled();
    expect(totalRemoveMock).not.toHaveBeenCalled();

    perKeySyncMock.mockClear();
    const resumed = await service.call(authEnv, row.friendlyId, "resumed", {
      roles: ["QUEUE", "LIMIT"],
    });
    expect(resumed.success).toBe(true);
    if (resumed.success) {
      expect(resumed.queue.paused).toBe(false);
      expect(resumed.queue.running).toBe(GATE_RUNNING);
      expect(resumed.queue.queued).toBe(GATE_QUEUED);
    }

    const resumedRow = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
    expect(resumedRow.paused).toBe(false);
    expect(perKeySyncMock).toHaveBeenCalledWith(authEnv, "limit/openai", 5);
    expect(perKeyRemoveMock).not.toHaveBeenCalled();
  });

  postgresTest(
    "a LIMIT friendly ID is rejected without the widened roles (the public queues endpoint's default)",
    async ({ prisma }) => {
      const { row, authEnv } = await seedEnvAndLimitRow(prisma);
      const service = new PauseQueueService(prisma);

      const result = await service.call(authEnv, row.friendlyId, "paused");
      expect(result).toMatchObject({ success: false, code: "queue-not-found" });

      const dbRow = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(dbRow.paused).toBe(false);
      expect(perKeySyncMock).not.toHaveBeenCalled();
    }
  );

  postgresTest(
    "a failed pause engine write compensates from the fresh row and still reports the failure",
    async ({ prisma }) => {
      const { row, authEnv } = await seedEnvAndLimitRow(prisma);
      const service = new PauseQueueService(prisma);

      perKeySyncMock.mockRejectedValueOnce(new Error("redis down"));
      const result = await service.call(authEnv, row.friendlyId, "paused", {
        roles: ["QUEUE", "LIMIT"],
      });
      expect(result).toMatchObject({ success: false, code: "unknown-error" });

      /**
       * The pause persisted before the failed write, so the compensating write
       * must re-sync 0 from the fresh row: exactly two per-key calls, the
       * rejected primary then the successful compensation.
       */
      const dbRow = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(dbRow.paused).toBe(true);
      expect(perKeySyncMock).toHaveBeenCalledTimes(2);
      expect(perKeySyncMock).toHaveBeenLastCalledWith(authEnv, "limit/openai", 0);
    }
  );

  postgresTest(
    "a pause committed during a dashboard override's engine write is re-asserted",
    async ({ prisma }) => {
      const { row, authEnv } = await seedEnvAndLimitRow(prisma);
      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      /**
       * The dashboard pairing under race: the override persists first, a pause
       * (PauseQueueService) commits and writes 0 while the override's engine
       * write is in flight, and the override's stale nonzero write lands last.
       * The override's fresh-row heal must re-assert 0.
       */
      perKeySyncMock.mockImplementationOnce(async () => {
        await prisma.taskQueue.update({ where: { id: row.id }, data: { paused: true } });
      });

      const overridden = await system.queues.overrideQueueConcurrencyLimit(
        authEnv,
        row.friendlyId,
        {
          limit: 10,
        }
      );
      expect(overridden.isOk()).toBe(true);

      expect(perKeySyncMock).toHaveBeenLastCalledWith(authEnv, "limit/openai", 0);
      const final = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(final.paused).toBe(true);
      expect(final.concurrencyLimit).toBe(10);
    }
  );

  postgresTest(
    "a pause committed during a resume's engine write is re-asserted",
    async ({ prisma }) => {
      const { row, authEnv } = await seedEnvAndLimitRow(prisma);
      await prisma.taskQueue.update({ where: { id: row.id }, data: { paused: true } });
      const service = new PauseQueueService(prisma);

      /**
       * The resume's engine write of the stored value is in flight when a
       * concurrent pause commits (its 0 already landed); the resume's freshness
       * re-check must re-assert 0 rather than leaving the stale value enforced.
       */
      perKeySyncMock.mockImplementationOnce(async () => {
        await prisma.taskQueue.update({ where: { id: row.id }, data: { paused: true } });
      });

      const resumed = await service.call(authEnv, row.friendlyId, "resumed", {
        roles: ["QUEUE", "LIMIT"],
      });
      expect(resumed.success).toBe(true);

      expect(perKeySyncMock).toHaveBeenLastCalledWith(authEnv, "limit/openai", 0);
      const final = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(final.paused).toBe(true);
    }
  );

  postgresTest("a QUEUE row still reports the per-queue counts", async ({ prisma }) => {
    const { row, authEnv } = await seedEnvAndLimitRow(prisma);
    const queueRow = await prisma.taskQueue.create({
      data: {
        friendlyId: `${row.friendlyId}_q`,
        name: "task/my-task",
        orderableName: "my-task",
        projectId: row.projectId,
        runtimeEnvironmentId: row.runtimeEnvironmentId,
        role: "QUEUE",
        concurrencyVersion: "V2",
      },
    });
    const service = new PauseQueueService(prisma);

    const paused = await service.call(authEnv, queueRow.friendlyId, "paused");
    expect(paused.success).toBe(true);
    if (paused.success) {
      expect(paused.queue.paused).toBe(true);
      expect(paused.queue.running).toBe(QUEUE_RUNNING);
      expect(paused.queue.queued).toBe(QUEUE_QUEUED);
    }
  });
});
