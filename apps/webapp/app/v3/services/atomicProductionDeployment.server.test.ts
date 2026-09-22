import { Pool } from "pg";
import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { atomicProductionDeploymentUrl } from "./atomicProductionDeployment.server";
import { TriggerDeployNowService } from "./triggerDeployNow.server";
import { marketplaceInitialDeploymentOptions } from "./marketplaceInitialDeploymentOptions.server";

const atomicTest = postgresTest.extend<{ lockPool: Pool }>({
  lockPool: async ({ postgresContainer }, runTest) => {
    const pool = new Pool({ connectionString: postgresContainer.getConnectionUri(), max: 3 });
    try {
      await runTest(pool);
    } finally {
      await pool.end();
    }
  },
});

atomicTest(
  "atomic production blocks standalone deployment while preserving other paths",
  async ({ prisma, lockPool }) => {
    const organization = await prisma.organization.create({
      data: {
        title: "Atomic",
        slug: randomUUID(),
        featureFlags: { deployNowEnabled: true },
      },
    });
    const project = await prisma.project.create({
      data: {
        name: "Atomic",
        slug: randomUUID(),
        externalRef: randomUUID(),
        organizationId: organization.id,
      },
    });
    const environment = await prisma.runtimeEnvironment.create({
      data: {
        slug: "prod",
        type: "PRODUCTION",
        apiKey: randomUUID(),
        pkApiKey: randomUUID(),
        shortcode: randomUUID(),
        organizationId: organization.id,
        projectId: project.id,
      },
    });
    const triggerCalls: unknown[] = [];
    const service = new TriggerDeployNowService(
      async (...args) => {
        triggerCalls.push(args);
        return { ok: true };
      },
      prisma,
      lockPool
    );
    const deploy = () =>
      service.call({
        projectId: project.id,
        environmentId: environment.id,
        environmentType: "PRODUCTION",
        branch: "main",
      });

    expect(await atomicProductionDeploymentUrl(project.id, "PRODUCTION", prisma)).toBeUndefined();
    const secret = await prisma.secretReference.create({ data: { key: randomUUID() } });
    const orgIntegration = await prisma.organizationIntegration.create({
      data: {
        friendlyId: randomUUID(),
        service: "VERCEL",
        organizationId: organization.id,
        tokenReferenceId: secret.id,
        integrationData: {},
      },
    });
    const data = {
      config: { atomicBuilds: ["prod"] },
      vercelProjectName: "customer-app",
      vercelTeamId: "team_test",
      vercelTeamSlug: "customer-team",
      vercelProjectId: "prj_test",
      syncEnvVarsMapping: {},
    };
    const integration = await prisma.organizationProjectIntegration.create({
      data: {
        organizationIntegrationId: orgIntegration.id,
        projectId: project.id,
        externalEntityId: "prj_test",
        integrationData: data,
      },
    });
    expect(await atomicProductionDeploymentUrl(project.id, "PRODUCTION", prisma)).toBe(
      "https://vercel.com/customer-team/customer-app"
    );
    expect(await deploy()).toEqual({
      ok: false,
      reason: "atomicProduction",
      vercelUrl: "https://vercel.com/customer-team/customer-app",
    });
    expect(triggerCalls).toHaveLength(0);
    expect(await prisma.workerDeployment.count({ where: { projectId: project.id } })).toBe(0);
    expect(await marketplaceInitialDeploymentOptions(project.id, organization.id, prisma)).toEqual({
      environment: "prod",
    });

    for (const environmentType of ["PREVIEW", "STAGING"] as const) {
      expect(
        await atomicProductionDeploymentUrl(project.id, environmentType, prisma)
      ).toBeUndefined();
      expect(
        await service.call({
          projectId: project.id,
          environmentId: environment.id,
          environmentType,
          branch: "feature/test",
        })
      ).toEqual({ ok: true });
    }
    expect(triggerCalls).toHaveLength(2);

    await prisma.organizationProjectIntegration.update({
      where: { id: integration.id },
      data: { integrationData: { ...data, vercelTeamSlug: undefined } },
    });
    expect(await atomicProductionDeploymentUrl(project.id, "PRODUCTION", prisma)).toBe(
      "https://vercel.com/dashboard"
    );
    await prisma.organizationProjectIntegration.update({
      where: { id: integration.id },
      data: { integrationData: { ...data, config: { atomicBuilds: [] } } },
    });
    expect(await deploy()).toEqual({ ok: true });
    expect(triggerCalls).toHaveLength(3);

    await prisma.organizationProjectIntegration.update({
      where: { id: integration.id },
      data: { integrationData: data, deletedAt: new Date() },
    });
    expect(await atomicProductionDeploymentUrl(project.id, "PRODUCTION", prisma)).toBeUndefined();
    await prisma.organizationProjectIntegration.update({
      where: { id: integration.id },
      data: { deletedAt: null },
    });
    await prisma.organizationIntegration.update({
      where: { id: orgIntegration.id },
      data: { deletedAt: new Date() },
    });
    expect(await atomicProductionDeploymentUrl(project.id, "PRODUCTION", prisma)).toBeUndefined();
  }
);
