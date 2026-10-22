import type { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { EnvironmentPauseSource } from "@trigger.dev/database";
import { postgresTest, redisTest } from "@internal/testcontainers";
import { Redis } from "ioredis";
import { describe, expect, vi } from "vitest";
import {
  convergeOrgRunsEnabled,
  provisionOrgStagingEnvironments,
  pushOrgConcurrencyLimits,
  reconcilingPush,
  setOrgConcurrencyLimits,
  type ProvisioningEnvironment,
} from "~/v3/services/orgPlanProvisioning.server";
import {
  createOrgProvisioningLock,
  OrgProvisioningBusyError,
} from "~/v3/services/orgProvisioningLock.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function seedOrg(prisma: PrismaClient) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  await prisma.project.update({ where: { id: project.id }, data: { version: "V3" } });

  const env = async (
    type: RuntimeEnvironmentType,
    data: {
      paused?: boolean;
      pauseSource?: EnvironmentPauseSource;
      archivedAt?: Date;
      parentEnvironmentId?: string;
    } = {}
  ) => {
    const created = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type,
      slug: uniqueId(type.toLowerCase()),
    });
    return prisma.runtimeEnvironment.update({ where: { id: created.id }, data });
  };

  const preview = await env("PREVIEW");
  const envs = {
    dev: await env("DEVELOPMENT"),
    running: await env("PRODUCTION"),
    paused: await env("STAGING", { paused: true }),
    billingPaused: await env("PRODUCTION", {
      paused: true,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    }),
    preview,
    archivedBranch: await env("PREVIEW", {
      paused: true,
      archivedAt: new Date(),
      parentEnvironmentId: preview.id,
    }),
  };

  return { organization, project, envs };
}

async function ids(prisma: PrismaClient, where: object) {
  const rows = await prisma.runtimeEnvironment.findMany({ where, select: { id: true } });
  return rows.map((row) => row.id).sort();
}

function recordingPush(fail: (env: ProvisioningEnvironment) => boolean = () => false) {
  const pushes: Array<{ id: string; limit: number }> = [];
  const push = async (env: ProvisioningEnvironment, limit: number) => {
    if (fail(env)) throw new Error("run queue unavailable");
    pushes.push({ id: env.id, limit });
  };
  return { pushes, push };
}

async function pausedIds(prisma: PrismaClient, organizationId: string) {
  return ids(prisma, { organizationId, paused: true });
}

describe("convergeOrgRunsEnabled", () => {
  postgresTest("resumes only user-paused envs and pushes every running one", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    await prisma.runtimeEnvironment.update({
      where: { id: envs.paused.id },
      data: { maximumConcurrencyLimit: 7 },
    });
    const { pushes, push } = recordingPush();

    const result = await convergeOrgRunsEnabled(organization.id, { prisma, pushEnvLimit: push });

    expect(result).toEqual({ updated: 1, pushed: 3 });
    expect(pushes.find((p) => p.id === envs.paused.id)?.limit).toBe(7);
    expect(pushes.map((p) => p.id).sort()).toEqual(
      [envs.running.id, envs.paused.id, envs.preview.id].sort()
    );
    expect(await pausedIds(prisma, organization.id)).toEqual(
      [envs.billingPaused.id, envs.archivedBranch.id].sort()
    );

    const again = await convergeOrgRunsEnabled(organization.id, { prisma, pushEnvLimit: push });
    expect(again).toEqual({ updated: 0, pushed: 3 });
  });

  postgresTest("pauses running non-dev envs when runs are disabled", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    await prisma.organization.update({
      where: { id: organization.id },
      data: { runsEnabled: false },
    });
    const { pushes, push } = recordingPush();

    const result = await convergeOrgRunsEnabled(organization.id, { prisma, pushEnvLimit: push });

    expect(result).toEqual({ updated: 2, pushed: 4 });
    expect(new Set(pushes.map((p) => p.limit))).toEqual(new Set([0]));
    expect(pushes.map((p) => p.id).sort()).toEqual(
      [envs.running.id, envs.paused.id, envs.billingPaused.id, envs.preview.id].sort()
    );
    expect(
      (await prisma.runtimeEnvironment.findFirstOrThrow({ where: { id: envs.dev.id } })).paused
    ).toBe(false);
  });

  postgresTest(
    "throws on a failed push and the retry re-pushes it although the row already changed",
    async ({ prisma }) => {
      const { organization, envs } = await seedOrg(prisma);
      const failing = recordingPush((env) => env.id === envs.paused.id);

      await expect(
        convergeOrgRunsEnabled(organization.id, { prisma, pushEnvLimit: failing.push })
      ).rejects.toThrow("Failed to resume 1 of 3 environments");
      expect(await pausedIds(prisma, organization.id)).not.toContain(envs.paused.id);

      const healthy = recordingPush();
      await convergeOrgRunsEnabled(organization.id, { prisma, pushEnvLimit: healthy.push });
      expect(healthy.pushes.map((p) => p.id)).toContain(envs.paused.id);
    }
  );
});

describe("reconcilingPush", () => {
  async function flipDuring(prisma: PrismaClient, id: string, states: boolean[]) {
    const pushes: number[] = [];
    const push = reconcilingPush(prisma, async (_env, limit) => {
      pushes.push(limit);
      const paused = states[pushes.length - 1];
      if (paused === undefined) return;
      await prisma.runtimeEnvironment.update({ where: { id }, data: { paused } });
    });
    return { pushes, push };
  }

  postgresTest("re-pushes the stored state when a pause lands mid-push", async ({ prisma }) => {
    const { organization, project, envs } = await seedOrg(prisma);
    await prisma.runtimeEnvironment.update({
      where: { id: envs.running.id },
      data: { maximumConcurrencyLimit: 7 },
    });
    const { pushes, push } = await flipDuring(prisma, envs.running.id, [true]);

    await push({ ...envs.running, organization, project }, 7);

    expect(pushes).toEqual([7, 0]);
  });

  postgresTest(
    "keeps reconciling when the state flips again during the corrective push",
    async ({ prisma }) => {
      const { organization, project, envs } = await seedOrg(prisma);
      await prisma.runtimeEnvironment.update({
        where: { id: envs.running.id },
        data: { maximumConcurrencyLimit: 7, paused: true },
      });
      const { pushes, push } = await flipDuring(prisma, envs.running.id, [false, true]);

      await push({ ...envs.running, organization, project }, 0);

      expect(pushes).toEqual([0, 7, 0]);
    }
  );

  postgresTest("throws when the state keeps changing", async ({ prisma }) => {
    const { organization, project, envs } = await seedOrg(prisma);
    await prisma.runtimeEnvironment.update({
      where: { id: envs.running.id },
      data: { maximumConcurrencyLimit: 7 },
    });
    const { push } = await flipDuring(prisma, envs.running.id, [true, false, true]);

    await expect(push({ ...envs.running, organization, project }, 7)).rejects.toThrow(
      "kept changing"
    );
  });
});

describe("org concurrency limits", () => {
  postgresTest("stores limits per env type and pushes the stored values", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    const { project: v2Project } = await createTestOrgProjectWithMember(prisma);
    await prisma.project.update({
      where: { id: v2Project.id },
      data: { organizationId: organization.id },
    });
    const v2Env = await createRuntimeEnvironment(prisma, {
      projectId: v2Project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
    });

    await setOrgConcurrencyLimits(
      organization.id,
      { organization: 100, development: 5, staging: 20, production: 50 },
      prisma
    );

    const org = await prisma.organization.findFirstOrThrow({ where: { id: organization.id } });
    expect(org.maximumConcurrencyLimit).toBe(100);

    const { pushes, push } = recordingPush();
    const result = await pushOrgConcurrencyLimits(organization.id, {
      prisma,
      pushEnvLimit: push,
      recalculatePercentLimits: async () => ({ failed: 0 }),
    });

    expect(result).toEqual({ pushed: 5 });
    const limitFor = (id: string) => pushes.find((p) => p.id === id)?.limit;
    expect(limitFor(envs.dev.id)).toBe(5);
    expect(limitFor(envs.running.id)).toBe(50);
    expect(limitFor(envs.preview.id)).toBe(20);
    expect(limitFor(envs.paused.id)).toBe(0);
    expect(limitFor(envs.billingPaused.id)).toBe(0);
    expect(limitFor(envs.archivedBranch.id)).toBeUndefined();
    expect(limitFor(v2Env.id)).toBeUndefined();
  });

  postgresTest("attempts every env before throwing on a failed push", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    const { pushes, push } = recordingPush((env) => env.id === envs.running.id);

    await expect(
      pushOrgConcurrencyLimits(organization.id, {
        prisma,
        pushEnvLimit: push,
        recalculatePercentLimits: async () => ({ failed: 0 }),
      })
    ).rejects.toThrow("Failed to push concurrency for 1 of 5 environments");
    expect(pushes).toHaveLength(4);
  });
  postgresTest("fails when a percent-limit recalculation reports failures", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    const { push } = recordingPush();

    await expect(
      pushOrgConcurrencyLimits(organization.id, {
        prisma,
        pushEnvLimit: push,
        recalculatePercentLimits: async (env) => ({ failed: env.id === envs.running.id ? 1 : 0 }),
      })
    ).rejects.toThrow("Failed to push concurrency for 1 of 5 environments");
  });
});

describe("provisionOrgStagingEnvironments", () => {
  postgresTest("creates missing root envs and re-pushes existing ones", async ({ prisma }) => {
    const { organization, envs } = await seedOrg(prisma);
    const { project: bare } = await createTestOrgProjectWithMember(prisma);
    await prisma.project.update({
      where: { id: bare.id },
      data: { organizationId: organization.id },
    });
    await prisma.project.create({
      data: {
        name: "Deleted",
        slug: uniqueId("deleted"),
        organizationId: organization.id,
        externalRef: uniqueId("ext"),
        deletedAt: new Date(),
      },
    });
    const created: string[] = [];
    const { pushes, push } = recordingPush();

    const result = await provisionOrgStagingEnvironments(organization.id, {
      prisma,
      pushEnvLimit: push,
      createEnvironment: async (_org, p, type) => {
        created.push(`${p.id}:${type}`);
      },
    });

    expect(result).toEqual({ created: 2, projects: 2 });
    expect(created.sort()).toEqual([`${bare.id}:PREVIEW`, `${bare.id}:STAGING`].sort());
    expect(pushes.map((p) => p.id).sort()).toEqual([envs.paused.id, envs.preview.id].sort());
    expect(pushes.find((p) => p.id === envs.paused.id)?.limit).toBe(0);
  });
});

describe("createOrgProvisioningLock", () => {
  redisTest("lets one holder run at a time and releases afterwards", async ({ redisOptions }) => {
    const redis = new Redis(redisOptions);
    const withLock = createOrgProvisioningLock(redis, 60_000);
    let release!: () => void;
    const held = withLock("job:org", () => new Promise<void>((r) => (release = r)));

    await expect(withLock("job:org", async () => "second")).rejects.toBeInstanceOf(
      OrgProvisioningBusyError
    );
    expect(await withLock("job:other", async () => "other")).toBe("other");

    release();
    await held;
    expect(await withLock("job:org", async () => "after")).toBe("after");

    await expect(
      withLock("job:org", async () => {
        throw new Error("boom");
      })
    ).rejects.toThrow("boom");
    expect(await withLock("job:org", async () => "released on error")).toBe("released on error");

    await redis.quit();
  });
});
