import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { ManageConcurrencyPresenter } from "~/presenters/v3/ManageConcurrencyPresenter.server";
import { AllocateConcurrencyService } from "~/v3/services/allocateConcurrency.server";

/**
 * These tests exercise the transactional quota invariant against a real Postgres
 * (postgresTest). Everything the service persists IS real; the pieces stubbed out are
 * the external boundaries only:
 * - the billing platform client (getCurrentPlan) has no container, so the plan is fixed,
 * - the run engine (Redis) syncs are replaced with spies, mirroring
 *   concurrencySystemPercentOverride.test.ts, so the tests can also assert that engine
 *   pushes happen only after a successful commit and never for a rejected allocation.
 */
const {
  getCurrentPlanMock,
  updateEnvConcurrencyLimitsEngineMock,
  recalculatePercentLimitsMock,
  invalidateEnvironmentMock,
} = vi.hoisted(() => ({
  getCurrentPlanMock: vi.fn(async (_orgId: string): Promise<unknown> => undefined),
  updateEnvConcurrencyLimitsEngineMock: vi.fn(async (..._args: unknown[]) => undefined),
  recalculatePercentLimitsMock: vi.fn(async (_environment: unknown) => ({
    total: 0,
    updated: 0,
    failed: 0,
  })),
  invalidateEnvironmentMock: vi.fn((_environmentId: string) => undefined),
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    getCurrentPlan: getCurrentPlanMock,
    getPlans: async () => ({
      addOnPricing: { concurrency: { stepSize: 1, centsPerStep: 100 } },
    }),
  };
});

vi.mock("~/v3/runEngine.server", () => ({
  engine: {
    lengthOfQueues: async () => ({}),
    currentConcurrencyOfQueues: async () => ({}),
    runQueue: {
      updateEnvConcurrencyLimits: updateEnvConcurrencyLimitsEngineMock,
      updateQueueConcurrencyLimits: async () => undefined,
      removeQueueConcurrencyLimits: async () => undefined,
    },
  },
}));

vi.mock("~/v3/runStore.server", () => ({ runStore: {} }));

vi.mock("~/v3/services/concurrencySystemInstance.server", () => ({
  concurrencySystem: {
    queues: {
      recalculatePercentLimits: recalculatePercentLimitsMock,
    },
  },
}));

vi.mock("~/v3/runOpsMigration/controlPlaneResolver.server", () => ({
  controlPlaneResolver: {
    invalidateEnvironment: invalidateEnvironmentMock,
  },
}));

vi.setConfig({ testTimeout: 60_000 });

const PLAN_ENV_LIMIT = 5;

function planWithPurchasedConcurrency(purchased: number): unknown {
  return {
    success: true,
    v3Subscription: {
      isPaying: true,
      plan: {
        limits: {
          concurrentRuns: {
            number: PLAN_ENV_LIMIT,
            canExceed: true,
            development: PLAN_ENV_LIMIT,
            staging: PLAN_ENV_LIMIT,
            preview: PLAN_ENV_LIMIT,
            production: PLAN_ENV_LIMIT,
          },
        },
      },
      addOns: {
        concurrentRuns: { purchased, quota: 100 },
      },
    },
  };
}

async function seedProjectWithEnvironments(prisma: PrismaClient, environmentCount: number) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;

  const organization = await prisma.organization.create({
    data: { title: slug, slug },
  });

  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });

  const environments = [];
  for (let i = 0; i < environmentCount; i++) {
    environments.push(
      await prisma.runtimeEnvironment.create({
        data: {
          slug: `${slug}-${i}`,
          type: "PRODUCTION",
          projectId: project.id,
          organizationId: organization.id,
          apiKey: `${slug}-${i}`,
          pkApiKey: `${slug}-${i}`,
          shortcode: `${slug}-${i}`,
          maximumConcurrencyLimit: PLAN_ENV_LIMIT,
        },
      })
    );
  }

  return { organization, project, environments };
}

async function totalAllocatedExtra(prisma: PrismaClient, organizationId: string) {
  const rows = await prisma.runtimeEnvironment.findMany({
    where: { organizationId },
    select: { maximumConcurrencyLimit: true },
  });
  return rows.reduce(
    (acc, row) => acc + Math.max(0, row.maximumConcurrencyLimit - PLAN_ENV_LIMIT),
    0
  );
}

describe("AllocateConcurrencyService", () => {
  postgresTest(
    "allocates within the pool and syncs the engine after commit",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();
      invalidateEnvironmentMock.mockClear();

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [{ id: environments[0].id, amount: 4 }],
      });

      expect(result).toEqual({ success: true });

      const row = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environments[0].id },
      });
      expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT + 4);

      expect(updateEnvConcurrencyLimitsEngineMock).toHaveBeenCalledTimes(1);
      expect(recalculatePercentLimitsMock).toHaveBeenCalledTimes(1);
      expect(recalculatePercentLimitsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: environments[0].id,
          maximumConcurrencyLimit: PLAN_ENV_LIMIT + 4,
        })
      );
      expect(invalidateEnvironmentMock).toHaveBeenCalledWith(environments[0].id);
    }
  );

  postgresTest(
    "rejects an allocation that exceeds the unallocated pool and syncs nothing",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 1);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [{ id: environments[0].id, amount: 11 }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("You don't have enough unallocated concurrency");
      }

      const row = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environments[0].id },
      });
      expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT);
      expect(updateEnvConcurrencyLimitsEngineMock).not.toHaveBeenCalled();
      expect(recalculatePercentLimitsMock).not.toHaveBeenCalled();
    }
  );

  postgresTest("rejects an environment outside the project", async ({ prisma }) => {
    const { organization, project } = await seedProjectWithEnvironments(prisma, 1);
    const other = await seedProjectWithEnvironments(prisma, 1);
    getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));

    const service = new AllocateConcurrencyService(prisma);
    const result = await service.call({
      userId: "user_1",
      projectId: project.id,
      organizationId: organization.id,
      environments: [{ id: other.environments[0].id, amount: 4 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Environment not found");
    }

    const row = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: other.environments[0].id },
    });
    expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT);
  });

  postgresTest(
    "persists nothing and syncs nothing when any requested environment is unknown",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();
      invalidateEnvironmentMock.mockClear();

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: environments[0].id, amount: 4 },
          { id: "env_bogus", amount: 1 },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Environment not found env_bogus");
      }

      const row = await prisma.runtimeEnvironment.findFirstOrThrow({
        where: { id: environments[0].id },
      });
      expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT);
      expect(updateEnvConcurrencyLimitsEngineMock).not.toHaveBeenCalled();
      expect(recalculatePercentLimitsMock).not.toHaveBeenCalled();
      expect(invalidateEnvironmentMock).not.toHaveBeenCalled();
    }
  );

  postgresTest(
    "self-heals a transient engine failure with one bounded inline retry",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();
      invalidateEnvironmentMock.mockClear();
      updateEnvConcurrencyLimitsEngineMock.mockRejectedValueOnce(new Error("engine down"));

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: environments[0].id, amount: 3 },
          { id: environments[1].id, amount: 3 },
        ],
      });

      expect(result).toEqual({ success: true });

      /**
       * The first environment's push failed once, so it must have been attempted a second
       * time, while the second environment synced exactly once despite the earlier failure.
       */
      const pushedIds = updateEnvConcurrencyLimitsEngineMock.mock.calls.map(
        (call) => (call[0] as { id: string }).id
      );
      expect(pushedIds).toEqual([environments[0].id, environments[1].id, environments[0].id]);

      const recalcedIds = recalculatePercentLimitsMock.mock.calls.map(
        (call) => (call[0] as { id: string }).id
      );
      expect(recalcedIds.filter((id) => id === environments[0].id)).toHaveLength(2);
      expect(recalcedIds.filter((id) => id === environments[1].id)).toHaveLength(1);
    }
  );

  postgresTest(
    "attempts every environment and reports an actionable message when a sync keeps failing",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();
      invalidateEnvironmentMock.mockClear();
      updateEnvConcurrencyLimitsEngineMock.mockImplementation(async (...args: unknown[]) => {
        if ((args[0] as { id: string }).id === environments[0].id) {
          throw new Error("engine down");
        }
        return undefined;
      });

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: environments[0].id, amount: 3 },
          { id: environments[1].id, amount: 3 },
        ],
      });

      updateEnvConcurrencyLimitsEngineMock.mockImplementation(
        async (..._args: unknown[]) => undefined
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error).toContain("Your allocation was saved");
        expect(result.error).toContain("Adjust any allocation value and save again");
      }

      /**
       * The database writes committed before the failed push, and the persistent failure of
       * the first environment's sync must not skip the second environment's sync or either
       * cache invalidation. The failing environment gets exactly two push attempts (the
       * initial one plus one retry); the healthy one exactly one.
       */
      for (const environment of environments) {
        const row = await prisma.runtimeEnvironment.findFirstOrThrow({
          where: { id: environment.id },
        });
        expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT + 3);
      }

      const pushedIds = updateEnvConcurrencyLimitsEngineMock.mock.calls.map(
        (call) => (call[0] as { id: string }).id
      );
      expect(pushedIds.filter((id) => id === environments[0].id)).toHaveLength(2);
      expect(pushedIds.filter((id) => id === environments[1].id)).toHaveLength(1);

      const invalidatedIds = invalidateEnvironmentMock.mock.calls.map((call) => call[0]);
      expect(invalidatedIds).toEqual([environments[0].id, environments[1].id]);
    }
  );

  postgresTest("rejects DEVELOPMENT environments even for their own member", async ({ prisma }) => {
    const { organization, project } = await seedProjectWithEnvironments(prisma, 1);
    const slug = `s${Math.random().toString(36).slice(2, 10)}`;
    const user = await prisma.user.create({
      data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
    });
    const member = await prisma.orgMember.create({
      data: { organizationId: organization.id, userId: user.id },
    });
    const devEnvironment = await prisma.runtimeEnvironment.create({
      data: {
        slug,
        type: "DEVELOPMENT",
        projectId: project.id,
        organizationId: organization.id,
        apiKey: slug,
        pkApiKey: slug,
        shortcode: slug,
        maximumConcurrencyLimit: PLAN_ENV_LIMIT,
        orgMemberId: member.id,
      },
    });
    getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
    updateEnvConcurrencyLimitsEngineMock.mockClear();
    recalculatePercentLimitsMock.mockClear();

    /**
     * Dev concurrency is not purchasable and extra dev limit is invisible to the org-wide
     * quota aggregate, so a crafted request naming a dev environment must be rejected
     * outright; accepting it would let the same purchased pool be spent twice.
     */
    const service = new AllocateConcurrencyService(prisma);
    const result = await service.call({
      userId: user.id,
      projectId: project.id,
      organizationId: organization.id,
      environments: [{ id: devEnvironment.id, amount: 10 }],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toContain("Environment not found");
    }

    const row = await prisma.runtimeEnvironment.findFirstOrThrow({
      where: { id: devEnvironment.id },
    });
    expect(row.maximumConcurrencyLimit).toBe(PLAN_ENV_LIMIT);
    expect(updateEnvConcurrencyLimitsEngineMock).not.toHaveBeenCalled();
    expect(recalculatePercentLimitsMock).not.toHaveBeenCalled();
  });

  postgresTest(
    "retries when a queue level push fails and reports failure when it keeps failing",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 1);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));

      /**
       * recalculatePercentLimits swallows per-queue engine failures and resolves normally,
       * reporting them only through its `failed` count, so the retry decision must consume
       * that count: a transient queue failure heals via the bounded retry, and a persistent
       * one must not be reported as fully applied.
       */
      recalculatePercentLimitsMock.mockClear();
      recalculatePercentLimitsMock.mockResolvedValueOnce({ total: 1, updated: 0, failed: 1 });

      const service = new AllocateConcurrencyService(prisma);
      const transient = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [{ id: environments[0].id, amount: 2 }],
      });

      expect(transient).toEqual({ success: true });
      expect(recalculatePercentLimitsMock).toHaveBeenCalledTimes(2);

      recalculatePercentLimitsMock.mockClear();
      recalculatePercentLimitsMock.mockResolvedValue({ total: 1, updated: 0, failed: 1 });

      const persistent = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [{ id: environments[0].id, amount: 3 }],
      });

      recalculatePercentLimitsMock.mockImplementation(async (_environment: unknown) => ({
        total: 0,
        updated: 0,
        failed: 0,
      }));

      expect(persistent.success).toBe(false);
      if (!persistent.success) {
        expect(persistent.error).toContain("Your allocation was saved");
      }
    }
  );

  postgresTest(
    "syncs the freshly committed row instead of the transaction snapshot",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();
      recalculatePercentLimitsMock.mockClear();

      /**
       * While the first environment's engine push runs, a newer change lands on the second
       * environment's row, simulating a concurrent allocation committing between this
       * transaction's commit and the second environment's sync. The second sync must carry
       * the fresh limit (99), not this transaction's snapshot (8): feeding the snapshot
       * would let a delayed older sync overwrite a newer committed limit.
       */
      updateEnvConcurrencyLimitsEngineMock.mockImplementationOnce(async (..._args: unknown[]) => {
        await prisma.runtimeEnvironment.update({
          where: { id: environments[1].id },
          data: { maximumConcurrencyLimit: 99 },
        });
        return undefined;
      });

      const service = new AllocateConcurrencyService(prisma);
      const result = await service.call({
        userId: "user_1",
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: environments[0].id, amount: 3 },
          { id: environments[1].id, amount: 3 },
        ],
      });

      expect(result).toEqual({ success: true });

      expect(recalculatePercentLimitsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: environments[0].id,
          maximumConcurrencyLimit: PLAN_ENV_LIMIT + 3,
        })
      );
      expect(recalculatePercentLimitsMock).toHaveBeenCalledWith(
        expect.objectContaining({
          id: environments[1].id,
          maximumConcurrencyLimit: 99,
        })
      );
    }
  );

  postgresTest(
    "quota math on a mixed org matches ManageConcurrencyPresenter",
    async ({ prisma }) => {
      const slug = `s${Math.random().toString(36).slice(2, 10)}`;
      const env = (suffix: string) => `${slug}-${suffix}`;

      const organization = await prisma.organization.create({ data: { title: slug, slug } });

      const user1 = await prisma.user.create({
        data: { email: `${slug}-u1@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      const user2 = await prisma.user.create({
        data: { email: `${slug}-u2@example.com`, authenticationMethod: "MAGIC_LINK" },
      });
      const member1 = await prisma.orgMember.create({
        data: { organizationId: organization.id, userId: user1.id },
      });
      const member2 = await prisma.orgMember.create({
        data: { organizationId: organization.id, userId: user2.id },
      });

      const project = await prisma.project.create({
        data: {
          name: env("main"),
          slug: env("main"),
          organizationId: organization.id,
          externalRef: env("main"),
        },
      });
      const deletedProject = await prisma.project.create({
        data: {
          name: env("deleted"),
          slug: env("deleted"),
          organizationId: organization.id,
          externalRef: env("deleted"),
          deletedAt: new Date(),
        },
      });
      const otherProject = await prisma.project.create({
        data: {
          name: env("other"),
          slug: env("other"),
          organizationId: organization.id,
          externalRef: env("other"),
        },
      });

      const createEnvironment = (data: {
        suffix: string;
        projectId: string;
        type: "PRODUCTION" | "STAGING" | "PREVIEW" | "DEVELOPMENT";
        maximumConcurrencyLimit: number;
        isBranchableEnvironment?: boolean;
        orgMemberId?: string;
        archivedAt?: Date;
      }) =>
        prisma.runtimeEnvironment.create({
          data: {
            slug: env(data.suffix),
            type: data.type,
            projectId: data.projectId,
            organizationId: organization.id,
            apiKey: env(data.suffix),
            pkApiKey: env(data.suffix),
            shortcode: env(data.suffix),
            maximumConcurrencyLimit: data.maximumConcurrencyLimit,
            isBranchableEnvironment: data.isBranchableEnvironment ?? false,
            orgMemberId: data.orgMemberId,
            archivedAt: data.archivedAt,
          },
        });

      /**
       * Allocated extra above the plan limit of 5: prod contributes 3, the preview child 2
       * and the other project's prod 4 (total 9). The branchable preview parent, the archived
       * env, the deleted project's env and both DEV envs must NOT count. Purchased 20 means
       * 11 unallocated.
       */
      const prod = await createEnvironment({
        suffix: "prod",
        projectId: project.id,
        type: "PRODUCTION",
        maximumConcurrencyLimit: 8,
      });
      await createEnvironment({
        suffix: "staging",
        projectId: project.id,
        type: "STAGING",
        maximumConcurrencyLimit: 5,
      });
      await createEnvironment({
        suffix: "preview-parent",
        projectId: project.id,
        type: "PREVIEW",
        maximumConcurrencyLimit: 50,
        isBranchableEnvironment: true,
      });
      await createEnvironment({
        suffix: "preview-child",
        projectId: project.id,
        type: "PREVIEW",
        maximumConcurrencyLimit: 7,
      });
      await createEnvironment({
        suffix: "dev-own",
        projectId: project.id,
        type: "DEVELOPMENT",
        maximumConcurrencyLimit: 9,
        orgMemberId: member1.id,
      });
      await createEnvironment({
        suffix: "dev-other",
        projectId: project.id,
        type: "DEVELOPMENT",
        maximumConcurrencyLimit: 9,
        orgMemberId: member2.id,
      });
      await createEnvironment({
        suffix: "archived",
        projectId: project.id,
        type: "PRODUCTION",
        maximumConcurrencyLimit: 30,
        archivedAt: new Date(),
      });
      await createEnvironment({
        suffix: "deleted-prod",
        projectId: deletedProject.id,
        type: "PRODUCTION",
        maximumConcurrencyLimit: 40,
      });
      await createEnvironment({
        suffix: "other-prod",
        projectId: otherProject.id,
        type: "PRODUCTION",
        maximumConcurrencyLimit: 9,
      });

      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(20));

      const presenter = new ManageConcurrencyPresenter(prisma, prisma);
      const presented = await presenter.call({
        userId: user1.id,
        projectId: project.id,
        organizationId: organization.id,
      });

      expect(presented.extraAllocatedConcurrency).toBe(9);
      expect(presented.extraUnallocatedConcurrency).toBe(11);

      const service = new AllocateConcurrencyService(prisma);
      const currentProdExtra = 3;

      const overAllocation = await service.call({
        userId: user1.id,
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: prod.id, amount: currentProdExtra + presented.extraUnallocatedConcurrency + 1 },
        ],
      });

      expect(overAllocation.success).toBe(false);
      if (!overAllocation.success) {
        expect(overAllocation.error).toContain(
          `only have ${presented.extraUnallocatedConcurrency}`
        );
      }

      const exactAllocation = await service.call({
        userId: user1.id,
        projectId: project.id,
        organizationId: organization.id,
        environments: [
          { id: prod.id, amount: currentProdExtra + presented.extraUnallocatedConcurrency },
        ],
      });

      expect(exactAllocation).toEqual({ success: true });

      const row = await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: prod.id } });
      expect(row.maximumConcurrencyLimit).toBe(
        PLAN_ENV_LIMIT + currentProdExtra + presented.extraUnallocatedConcurrency
      );

      const presentedAfter = await presenter.call({
        userId: user1.id,
        projectId: project.id,
        organizationId: organization.id,
      });
      expect(presentedAfter.extraAllocatedConcurrency).toBe(20);
      expect(presentedAfter.extraUnallocatedConcurrency).toBe(0);
    }
  );

  postgresTest(
    "two concurrent allocations cannot jointly exceed the purchased pool",
    async ({ prisma }) => {
      const { organization, project, environments } = await seedProjectWithEnvironments(prisma, 2);
      getCurrentPlanMock.mockResolvedValue(planWithPurchasedConcurrency(10));
      updateEnvConcurrencyLimitsEngineMock.mockClear();

      /**
       * Each request alone fits the pool (10), together they would need 20. Whether the
       * transactions overlap (the loser fails with a serialization conflict) or serialize
       * (the second one re-reads committed state and fails the quota check), exactly one
       * may succeed and the committed allocation must never exceed the pool.
       */
      const serviceA = new AllocateConcurrencyService(prisma);
      const serviceB = new AllocateConcurrencyService(prisma);

      const [resultA, resultB] = await Promise.all([
        serviceA.call({
          userId: "user_1",
          projectId: project.id,
          organizationId: organization.id,
          environments: [{ id: environments[0].id, amount: 10 }],
        }),
        serviceB.call({
          userId: "user_1",
          projectId: project.id,
          organizationId: organization.id,
          environments: [{ id: environments[1].id, amount: 10 }],
        }),
      ]);

      const results = [resultA, resultB];
      const successes = results.filter((r) => r.success);
      const failures = results.filter((r) => !r.success);

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);
      const failure = failures[0];
      if (!failure.success) {
        expect(failure.error).toMatch(
          /You don't have enough unallocated concurrency|changed while saving/
        );
      }

      const allocated = await totalAllocatedExtra(prisma, organization.id);
      expect(allocated).toBeLessThanOrEqual(10);
      expect(allocated).toBe(10);

      expect(updateEnvConcurrencyLimitsEngineMock).toHaveBeenCalledTimes(1);
    }
  );
});
