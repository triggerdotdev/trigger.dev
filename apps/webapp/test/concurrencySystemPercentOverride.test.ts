import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import { ConcurrencySystem, materializePercentLimit } from "~/v3/services/concurrencySystem.server";

// The real run engine opens eager Redis connections and needs the whole engine
// wired up. These tests exercise the DB-write + recalculation logic against a
// real Postgres (postgresTest), so we replace the engine singleton with a thin
// stub that satisfies the sync + stats calls the service makes. The engine sync
// itself (RunQueue/Redis) is therefore NOT exercised here — see the note in the
// verification report. Everything the service persists to Postgres IS real.
// A controllable spy for the engine's queue-limit push so a test can simulate a push failure and
// prove the next recalc self-heals the divergence.
// This mocks the ENGINE method (`engine.runQueue.updateQueueConcurrencyLimits`). The service calls
// the top-level `updateQueueConcurrencyLimits` from `~/v3/runQueue.server`, which forwards straight
// to this engine method with the same `(environment, queueName, concurrency)` argument order (no
// transformation) — so mocking the engine method genuinely exercises the recalc's sync path and the
// `(env, queueName, 10)` assertion below is exact.
const { updateQueueConcurrencyLimitsMock } = vi.hoisted(() => ({
  updateQueueConcurrencyLimitsMock: vi.fn(async (..._args: unknown[]) => undefined),
}));

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    lengthOfQueues: async () => ({}),
    currentConcurrencyOfQueues: async () => ({}),
    runQueue: {
      updateQueueConcurrencyLimits: updateQueueConcurrencyLimitsMock,
      removeQueueConcurrencyLimits: async () => undefined,
      updateEnvConcurrencyLimits: async () => undefined,
    },
  },
}));

vi.setConfig({ testTimeout: 30_000 });

describe("materializePercentLimit", () => {
  it("floors the materialized value", () => {
    // 10 * 55 / 100 = 5.5 -> floor -> 5
    expect(materializePercentLimit(10, 55)).toBe(5);
    // 7 * 50 / 100 = 3.5 -> floor -> 3
    expect(materializePercentLimit(7, 50)).toBe(3);
  });

  it("clamps to at least 1 so a percent override never produces a 0 (pause-like) limit", () => {
    // 10 * 1 / 100 = 0.1 -> floor -> 0 -> clamp up to 1
    expect(materializePercentLimit(10, 1)).toBe(1);
    // tiny env, small percent still floors to 0 then clamps to 1
    expect(materializePercentLimit(1, 1)).toBe(1);
    expect(materializePercentLimit(3, 10)).toBe(1);
  });

  it("clamps to at most the environment limit at 100%", () => {
    expect(materializePercentLimit(10, 100)).toBe(10);
    expect(materializePercentLimit(1, 100)).toBe(1);
    expect(materializePercentLimit(250, 100)).toBe(250);
  });

  it("handles a tiny environment limit at the 100% boundary", () => {
    expect(materializePercentLimit(1, 50)).toBe(1); // 0.5 -> 0 -> clamp to 1
    expect(materializePercentLimit(2, 50)).toBe(1); // 1.0 -> 1
    expect(materializePercentLimit(2, 100)).toBe(2);
  });

  it("supports fractional percentages", () => {
    // 100 * 12.5 / 100 = 12.5 -> floor -> 12
    expect(materializePercentLimit(100, 12.5)).toBe(12);
  });
});

async function seedEnvAndQueue(
  prisma: PrismaClient,
  opts: { maximumConcurrencyLimit: number; queueConcurrencyLimit?: number | null }
) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;

  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });

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
      maximumConcurrencyLimit: opts.maximumConcurrencyLimit,
    },
  });

  const queue = await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${slug}`,
      name: `task/${slug}`,
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
      concurrencyLimit: opts.queueConcurrencyLimit ?? null,
    },
  });

  const authEnv = {
    id: environment.id,
    maximumConcurrencyLimit: environment.maximumConcurrencyLimit,
  } as unknown as AuthenticatedEnvironment;

  return { organization, project, environment, queue, authEnv };
}

describe("ConcurrencySystem percent overrides", () => {
  postgresTest(
    "materializes a percent override and stores the percent as the source of truth",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedEnvAndQueue(prisma, {
        maximumConcurrencyLimit: 10,
        queueConcurrencyLimit: 8,
      });

      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const result = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
        percent: 50,
      });

      expect(result.isOk()).toBe(true);

      const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
      // floor(10 * 50 / 100) = 5
      expect(row.concurrencyLimit).toBe(5);
      expect(row.concurrencyLimitOverridePercent?.toNumber()).toBe(50);
      // base captures the pre-override absolute limit
      expect(row.concurrencyLimitBase).toBe(8);
      expect(row.concurrencyLimitOverriddenAt).not.toBeNull();
    }
  );

  postgresTest(
    "rejects an absolute override that exceeds the environment limit and persists nothing",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedEnvAndQueue(prisma, {
        maximumConcurrencyLimit: 10,
        queueConcurrencyLimit: 8,
      });

      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const result = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
        limit: 9999,
      });

      expect(result.isErr()).toBe(true);
      if (result.isErr()) {
        expect(result.error.type).toBe("concurrency_limit_exceeds_maximum");
      }

      // Nothing should have been written.
      const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
      expect(row.concurrencyLimit).toBe(8);
      expect(row.concurrencyLimitOverridePercent).toBeNull();
      expect(row.concurrencyLimitOverriddenAt).toBeNull();
      expect(row.concurrencyLimitBase).toBeNull();
    }
  );

  postgresTest("rejects an out-of-range percent as invalid_override", async ({ prisma }) => {
    const { queue, authEnv } = await seedEnvAndQueue(prisma, {
      maximumConcurrencyLimit: 10,
    });

    const system = new ConcurrencySystem({ db: prisma, reader: prisma });

    const tooHigh = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
      percent: 101,
    });
    expect(tooHigh.isErr()).toBe(true);
    if (tooHigh.isErr()) expect(tooHigh.error.type).toBe("invalid_override");

    const tooLow = await system.queues.overrideQueueConcurrencyLimit(authEnv, queue.friendlyId, {
      percent: 0,
    });
    expect(tooLow.isErr()).toBe(true);
    if (tooLow.isErr()) expect(tooLow.error.type).toBe("invalid_override");

    const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
    expect(row.concurrencyLimitOverriddenAt).toBeNull();
  });

  postgresTest("reset clears both the absolute limit and the percent", async ({ prisma }) => {
    const { queue, authEnv } = await seedEnvAndQueue(prisma, {
      maximumConcurrencyLimit: 10,
      queueConcurrencyLimit: 8,
    });

    const system = new ConcurrencySystem({ db: prisma, reader: prisma });

    const overridden = await system.queues.overrideQueueConcurrencyLimit(
      authEnv,
      queue.friendlyId,
      { percent: 50 }
    );
    expect(overridden.isOk()).toBe(true);

    const reset = await system.queues.resetConcurrencyLimit(authEnv, queue.friendlyId);
    expect(reset.isOk()).toBe(true);

    const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
    // restored to the base captured at override time
    expect(row.concurrencyLimit).toBe(8);
    expect(row.concurrencyLimitOverridePercent).toBeNull();
    expect(row.concurrencyLimitBase).toBeNull();
    expect(row.concurrencyLimitOverriddenAt).toBeNull();
    expect(row.concurrencyLimitOverriddenBy).toBeNull();
  });

  postgresTest(
    "recalculatePercentLimits recomputes percent queues and leaves absolute overrides untouched",
    async ({ prisma }) => {
      const { project, environment, authEnv } = await seedEnvAndQueue(prisma, {
        maximumConcurrencyLimit: 10,
        queueConcurrencyLimit: 8,
      });

      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      // A percent-based queue: 50% of env(10) -> 5
      const percentQueue = await prisma.taskQueue.create({
        data: {
          friendlyId: `queue_pct_${Math.random().toString(36).slice(2, 8)}`,
          name: `task/pct-${Math.random().toString(36).slice(2, 8)}`,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          concurrencyLimit: 6,
        },
      });
      const pctResult = await system.queues.overrideQueueConcurrencyLimit(
        authEnv,
        percentQueue.friendlyId,
        { percent: 50 }
      );
      expect(pctResult.isOk()).toBe(true);
      {
        const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: percentQueue.id } });
        expect(row.concurrencyLimit).toBe(5); // floor(10 * 0.5)
      }

      // An absolute-override queue: limit 4, no percent
      const absQueue = await prisma.taskQueue.create({
        data: {
          friendlyId: `queue_abs_${Math.random().toString(36).slice(2, 8)}`,
          name: `task/abs-${Math.random().toString(36).slice(2, 8)}`,
          projectId: project.id,
          runtimeEnvironmentId: environment.id,
          concurrencyLimit: 6,
        },
      });
      const absResult = await system.queues.overrideQueueConcurrencyLimit(
        authEnv,
        absQueue.friendlyId,
        { limit: 4 }
      );
      expect(absResult.isOk()).toBe(true);

      // Simulate the environment limit changing from 10 -> 20 and recalculate.
      const bumpedEnv = {
        id: environment.id,
        maximumConcurrencyLimit: 20,
      } as unknown as AuthenticatedEnvironment;

      const outcome = await system.queues.recalculatePercentLimits(bumpedEnv);
      expect(outcome.total).toBe(1); // only the percent queue is considered
      expect(outcome.updated).toBe(1);

      const pctRow = await prisma.taskQueue.findUniqueOrThrow({ where: { id: percentQueue.id } });
      // floor(20 * 50 / 100) = 10
      expect(pctRow.concurrencyLimit).toBe(10);
      expect(pctRow.concurrencyLimitOverridePercent?.toNumber()).toBe(50);

      const absRow = await prisma.taskQueue.findUniqueOrThrow({ where: { id: absQueue.id } });
      // absolute override must be untouched
      expect(absRow.concurrencyLimit).toBe(4);
      expect(absRow.concurrencyLimitOverridePercent).toBeNull();
    }
  );

  postgresTest(
    "recalculatePercentLimits is idempotent when the limit is unchanged",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedEnvAndQueue(prisma, {
        maximumConcurrencyLimit: 10,
        queueConcurrencyLimit: 8,
      });

      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const overridden = await system.queues.overrideQueueConcurrencyLimit(
        authEnv,
        queue.friendlyId,
        { percent: 50 }
      );
      expect(overridden.isOk()).toBe(true);

      // Recalculate against the SAME environment limit -> nothing to update.
      const outcome = await system.queues.recalculatePercentLimits(authEnv);
      expect(outcome.total).toBe(1);
      expect(outcome.updated).toBe(0);

      const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
      expect(row.concurrencyLimit).toBe(5);
    }
  );

  postgresTest(
    "recalculatePercentLimits re-syncs the engine on a later recalc after an engine push failed, even when the DB limit is unchanged",
    async ({ prisma }) => {
      const { queue, authEnv } = await seedEnvAndQueue(prisma, {
        maximumConcurrencyLimit: 10,
        queueConcurrencyLimit: 8,
      });

      const system = new ConcurrencySystem({ db: prisma, reader: prisma });

      const overridden = await system.queues.overrideQueueConcurrencyLimit(
        authEnv,
        queue.friendlyId,
        { percent: 50 }
      );
      expect(overridden.isOk()).toBe(true);
      {
        const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
        expect(row.concurrencyLimit).toBe(5); // floor(10 * 0.5)
      }

      const bumpedEnv = {
        id: authEnv.id,
        maximumConcurrencyLimit: 20,
      } as unknown as AuthenticatedEnvironment;

      // The env-limit bump recalc writes the new DB limit (10) but the engine push fails and is
      // swallowed by the per-queue catch: DB and engine are now diverged (DB=10, engine=5).
      updateQueueConcurrencyLimitsMock.mockClear();
      updateQueueConcurrencyLimitsMock.mockRejectedValueOnce(new Error("engine push failed"));

      const first = await system.queues.recalculatePercentLimits(bumpedEnv);
      expect(first.updated).toBe(1); // DB was written before the push threw
      {
        const row = await prisma.taskQueue.findUniqueOrThrow({ where: { id: queue.id } });
        expect(row.concurrencyLimit).toBe(10);
      }

      // A later recalc at the SAME env limit makes no DB change, but MUST still push to the engine
      // so the previously-failed sync self-heals. (Regression guard: the old code `continue`d when
      // newLimit === concurrencyLimit and left the engine stuck at 5 forever.)
      updateQueueConcurrencyLimitsMock.mockClear();
      const second = await system.queues.recalculatePercentLimits(bumpedEnv);
      expect(second.updated).toBe(0); // no DB write
      expect(updateQueueConcurrencyLimitsMock).toHaveBeenCalledWith(
        expect.anything(),
        queue.name,
        10
      );
    }
  );
});
