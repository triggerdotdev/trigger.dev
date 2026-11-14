import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect } from "vitest";
import { VercelIntegrationService } from "~/services/vercelIntegration.server";
import { createDefaultVercelIntegrationData } from "~/v3/vercel/vercelProjectIntegrationSchema";

async function seedProjectWithMapping(
  prisma: PrismaClient,
  syncEnvVarsMapping: Record<string, Record<string, boolean>>
) {
  const organization = await prisma.organization.create({
    data: { title: "Org", slug: "org-sync-removal" },
  });
  const project = await prisma.project.create({
    data: {
      name: "Project",
      slug: "project-sync-removal",
      organizationId: organization.id,
      externalRef: "proj_sync_removal",
    },
  });
  const tokenReference = await prisma.secretReference.create({
    data: { key: "secret-sync-removal" },
  });
  const organizationIntegration = await prisma.organizationIntegration.create({
    data: {
      friendlyId: "oi-sync-removal",
      service: "VERCEL",
      integrationData: {},
      tokenReferenceId: tokenReference.id,
      organizationId: organization.id,
    },
  });
  const integration = await prisma.organizationProjectIntegration.create({
    data: {
      organizationIntegrationId: organizationIntegration.id,
      projectId: project.id,
      externalEntityId: "vercel-project",
      integrationData: {
        ...createDefaultVercelIntegrationData("vercel-project", "Vercel project", null),
        syncEnvVarsMapping,
      },
    },
  });
  return { project, integration };
}

describe("VercelIntegrationService.removeSyncEnvVars", () => {
  // Catches: a removal of several keys that keeps only the last one's change, because each
  // key was taken out of the mapping as it was first read.
  postgresTest("removes every listed key and keeps the rest", async ({ prisma }) => {
    const { project, integration } = await seedProjectWithMapping(prisma, {
      prod: { A: false, B: false, KEPT: false },
      preview: { A: false },
      stg: { A: false },
    });

    await new VercelIntegrationService(prisma).removeSyncEnvVars(project.id, [
      { key: "A", type: "PRODUCTION" },
      { key: "B", type: "PRODUCTION" },
      { key: "A", type: "PREVIEW" },
      { key: "NOT_MAPPED", type: "PRODUCTION" },
    ]);

    const after = await prisma.organizationProjectIntegration.findUniqueOrThrow({
      where: { id: integration.id },
    });
    expect((after.integrationData as { syncEnvVarsMapping: unknown }).syncEnvVarsMapping).toEqual({
      prod: { KEPT: false },
      preview: {},
      stg: { A: false },
    });
  });
});
