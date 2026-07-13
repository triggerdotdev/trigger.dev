import type { PrismaClient } from "@trigger.dev/database";
import { EnvironmentPauseSource } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { postgresTest } from "@internal/testcontainers";
import { convergeBillingLimitEnvironmentsForOrg } from "~/v3/services/billingLimit/billingLimitConvergeEnvironments.server";
import {
  createRuntimeEnvironment,
  createTestOrgProjectWithMember,
  uniqueId,
} from "./fixtures/environmentVariablesFixtures";

vi.setConfig({ testTimeout: 60_000 });

async function createBillingPausedProductionEnv(prisma: PrismaClient) {
  const { organization, project } = await createTestOrgProjectWithMember(prisma);
  const environment = await createRuntimeEnvironment(prisma, {
    projectId: project.id,
    organizationId: organization.id,
    type: "PRODUCTION",
    slug: uniqueId("prod"),
  });

  await prisma.runtimeEnvironment.update({
    where: { id: environment.id },
    data: {
      paused: true,
      pauseSource: EnvironmentPauseSource.BILLING_LIMIT,
    },
  });

  return { organization, environment };
}

describe("convergeBillingLimitEnvironmentsForOrg", () => {
  postgresTest("unpauses billable environments paused by billing limit", async ({ prisma }) => {
    const { organization, environment } = await createBillingPausedProductionEnv(prisma);

    const result = await convergeBillingLimitEnvironmentsForOrg(organization.id, "ok", {
      prismaClient: prisma,
      updateConcurrency: async () => undefined,
    });

    expect(result).toEqual({ paused: 0, unpaused: 1 });

    const envAfter = await prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
    });
    expect(envAfter.paused).toBe(false);
    expect(envAfter.pauseSource).toBeNull();
  });

  postgresTest("rolls back pause when concurrency update fails", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    });

    await expect(
      convergeBillingLimitEnvironmentsForOrg(organization.id, "grace", {
        prismaClient: prisma,
        updateConcurrency: async () => {
          throw new Error("run queue unavailable");
        },
      })
    ).rejects.toThrow("run queue unavailable");

    const envAfter = await prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
    });
    expect(envAfter.paused).toBe(false);
    expect(envAfter.pauseSource).toBeNull();
  });

  postgresTest("does not unpause environments paused for other reasons", async ({ prisma }) => {
    const { organization, project } = await createTestOrgProjectWithMember(prisma);
    const environment = await createRuntimeEnvironment(prisma, {
      projectId: project.id,
      organizationId: organization.id,
      type: "PRODUCTION",
      slug: uniqueId("prod"),
    });

    await prisma.runtimeEnvironment.update({
      where: { id: environment.id },
      data: {
        paused: true,
        pauseSource: null,
      },
    });

    const result = await convergeBillingLimitEnvironmentsForOrg(organization.id, "ok", {
      prismaClient: prisma,
      updateConcurrency: async () => undefined,
    });

    expect(result).toEqual({ paused: 0, unpaused: 0 });

    const envAfter = await prisma.runtimeEnvironment.findUniqueOrThrow({
      where: { id: environment.id },
    });
    expect(envAfter.paused).toBe(true);
    expect(envAfter.pauseSource).toBeNull();
  });
});
