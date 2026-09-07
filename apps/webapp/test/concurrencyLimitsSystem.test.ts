import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencyLimitsSystem } from "~/v3/services/concurrencyLimitsSystem.server";

/**
 * These tests exercise the DB-write, marker and ordering logic against a real
 * Postgres. The engine syncs are spies so tests can assert ordering and inject
 * failures; the Redis side itself is covered by the run-engine suites.
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

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    totalConcurrencyOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
    gateQueuedCountOfQueues: async (_env: unknown, queues: string[]) =>
      Object.fromEntries(queues.map((q) => [q, 0])),
  },
}));

vi.setConfig({ testTimeout: 30_000 });

async function seedEnvAndLimit(
  prisma: PrismaClient,
  opts: { perKey?: number | null; total?: number | null } = {}
) {
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
      concurrencyLimit: opts.perKey ?? null,
      totalConcurrencyLimit: opts.total ?? null,
    },
  });

  const authEnv = {
    id: environment.id,
    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
  } as unknown as AuthenticatedEnvironment;

  const system = new ConcurrencyLimitsSystem({ db: prisma, reader: prisma });

  return { environment, row, authEnv, system };
}

describe("ConcurrencyLimitsSystem", () => {
  postgresTest(
    "override changes only the given bound and keeps the declared base",
    async ({ prisma }) => {
      const { authEnv, system, row } = await seedEnvAndLimit(prisma, { total: 25 });

      const result = await system.limits.override(authEnv, "openai", { total: 50 });
      expect(result.isOk()).toBe(true);
      if (result.isOk()) {
        expect(result.value.total).toMatchObject({ current: 50, base: 25, override: 50 });
        expect(result.value.perKey).toMatchObject({ current: null, override: null });
      }

      const updated = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(updated.totalConcurrencyLimit).toBe(50);
      expect(updated.totalConcurrencyLimitBase).toBe(25);
      expect(updated.totalConcurrencyLimitOverriddenAt).not.toBeNull();
      expect(updated.concurrencyLimitOverriddenAt).toBeNull();

      expect(totalSyncMock).toHaveBeenCalledWith(authEnv, "limit/openai", 50);
      expect(perKeyRemoveMock).toHaveBeenCalledWith(authEnv, "limit/openai");
    }
  );

  postgresTest("override to zero pauses the limit in the engine", async ({ prisma }) => {
    const { authEnv, system } = await seedEnvAndLimit(prisma, { total: 25 });

    const result = await system.limits.override(authEnv, "openai", { total: 0 });
    expect(result.isOk()).toBe(true);
    expect(totalSyncMock).toHaveBeenCalledWith(authEnv, "limit/openai", 0);
  });

  postgresTest("reset restores the declared values and clears the markers", async ({ prisma }) => {
    const { authEnv, system, row } = await seedEnvAndLimit(prisma, { perKey: 2, total: 25 });

    await system.limits.override(authEnv, "openai", { perKey: 10, total: 50 });
    const result = await system.limits.reset(authEnv, "openai");
    expect(result.isOk()).toBe(true);
    if (result.isOk()) {
      expect(result.value.total).toMatchObject({ current: 25, base: 25, override: null });
      expect(result.value.perKey).toMatchObject({ current: 2, base: 2, override: null });
    }

    const updated = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
    expect(updated.concurrencyLimit).toBe(2);
    expect(updated.totalConcurrencyLimit).toBe(25);
    expect(updated.concurrencyLimitOverriddenAt).toBeNull();
    expect(updated.totalConcurrencyLimitOverriddenAt).toBeNull();
  });

  postgresTest("reset without an override is rejected", async ({ prisma }) => {
    const { authEnv, system } = await seedEnvAndLimit(prisma, { total: 25 });

    const result = await system.limits.reset(authEnv, "openai");
    expect(result.isErr()).toBe(true);
    if (result.isErr()) {
      expect(result.error.type).toBe("limit_not_overridden");
    }
  });

  postgresTest(
    "a failed engine sync during reset leaves the override intact so a retry converges",
    async ({ prisma }) => {
      const { authEnv, system, row } = await seedEnvAndLimit(prisma, { total: 25 });

      await system.limits.override(authEnv, "openai", { total: 50 });

      totalSyncMock.mockRejectedValueOnce(new Error("redis down"));
      const failed = await system.limits.reset(authEnv, "openai");
      expect(failed.isErr()).toBe(true);

      /** The marker must survive the failed sync: the DB still says overridden. */
      const midway = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(midway.totalConcurrencyLimitOverriddenAt).not.toBeNull();
      expect(midway.totalConcurrencyLimit).toBe(50);

      const retried = await system.limits.reset(authEnv, "openai");
      expect(retried.isOk()).toBe(true);
      const final = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(final.totalConcurrencyLimit).toBe(25);
      expect(final.totalConcurrencyLimitOverriddenAt).toBeNull();
    }
  );

  postgresTest(
    "a mutation whose markers moved underneath it conflicts instead of clobbering",
    async ({ prisma }) => {
      const { authEnv, system, row } = await seedEnvAndLimit(prisma, { total: 25 });

      await system.limits.override(authEnv, "openai", { total: 50 });

      /**
       * Interleave a concurrent reset between this mutation's read and its write:
       * the engine sync hook is the seam after the read, so clearing the markers
       * there makes the guarded update miss and surface a conflict.
       */
      totalSyncMock.mockImplementationOnce(async () => {
        await prisma.taskQueue.update({
          where: { id: row.id },
          data: {
            totalConcurrencyLimit: 25,
            totalConcurrencyLimitBase: null,
            totalConcurrencyLimitOverriddenAt: null,
            totalConcurrencyLimitOverriddenBy: null,
          },
        });
      });

      const raced = await system.limits.reset(authEnv, "openai");
      expect(raced.isErr()).toBe(true);
      if (raced.isErr()) {
        expect(raced.error.type).toBe("conflict");
      }

      /** The concurrent actor's state stands untouched. */
      const final = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(final.totalConcurrencyLimit).toBe(25);
      expect(final.totalConcurrencyLimitOverriddenAt).toBeNull();
    }
  );

  postgresTest(
    "a failed engine sync during override compensates from the fresh row",
    async ({ prisma }) => {
      const { authEnv, system, row } = await seedEnvAndLimit(prisma, { total: 25 });

      totalSyncMock.mockRejectedValueOnce(new Error("redis down"));
      const failed = await system.limits.override(authEnv, "openai", { total: 50 });
      expect(failed.isErr()).toBe(true);
      if (failed.isErr()) {
        expect(failed.error.type).toBe("sync_limit_to_engine_failed");
      }

      /** The persist already happened; compensation re-syncs it so the engine
       * doesn't keep enforcing the old bound while the API reports the new one. */
      const updated = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(updated.totalConcurrencyLimit).toBe(50);
      expect(totalSyncMock).toHaveBeenLastCalledWith(authEnv, "limit/openai", 50);
      expect(totalSyncMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    }
  );

  postgresTest(
    "an older override's engine write landing last is repaired by the freshness re-check",
    async ({ prisma }) => {
      const { authEnv, system, row } = await seedEnvAndLimit(prisma, { total: 25 });

      /** `engineTotal` is written when a sync "lands", so landing order can differ
       * from call order: the first override's write is delayed until a second,
       * newer override has fully completed, then lands with the stale value. */
      let engineTotal: number | null = null;
      let secondResult: Awaited<ReturnType<typeof system.limits.override>> | undefined;
      totalSyncMock.mockImplementation(async (_env, _name, value) => {
        engineTotal = value as number;
      });
      totalSyncMock.mockImplementationOnce(async (_env, _name, value) => {
        secondResult = await system.limits.override(authEnv, "openai", { total: 75 });
        engineTotal = value as number;
      });

      const first = await system.limits.override(authEnv, "openai", { total: 50 });
      expect(first.isOk()).toBe(true);
      expect(secondResult?.isOk()).toBe(true);

      const final = await prisma.taskQueue.findFirstOrThrow({ where: { id: row.id } });
      expect(final.totalConcurrencyLimit).toBe(75);
      expect(engineTotal).toBe(75);

      totalSyncMock.mockImplementation(async () => undefined);
    }
  );

  postgresTest("retrieve misses queue-role rows and unknown names", async ({ prisma }) => {
    const { authEnv, system, environment } = await seedEnvAndLimit(prisma, { total: 25 });

    await prisma.taskQueue.create({
      data: {
        friendlyId: `queue_q${environment.slug}`,
        name: "limit/shadow",
        orderableName: "shadow",
        projectId: environment.projectId,
        runtimeEnvironmentId: environment.id,
        role: "QUEUE",
      },
    });

    const missing = await system.limits.retrieve(authEnv, "missing");
    expect(missing.isErr()).toBe(true);

    const shadow = await system.limits.retrieve(authEnv, "shadow");
    expect(shadow.isErr()).toBe(true);
  });
});
