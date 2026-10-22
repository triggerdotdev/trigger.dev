import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";
import { hasLegacyAlerts } from "~/components/alerts/hasLegacyAlerts.server";

vi.setConfig({ testTimeout: 60_000 });

async function seedProject(prisma: PrismaClient, alertTypeSets: string[][]) {
  const slug = `s${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: slug },
  });
  for (const [i, alertTypes] of alertTypeSets.entries()) {
    await prisma.projectAlertChannel.create({
      data: {
        friendlyId: `${slug}_${i}`,
        name: `c${i}`,
        type: "EMAIL",
        properties: { type: "EMAIL", email: "a@example.com" },
        alertTypes: alertTypes as never,
        deduplicationKey: `${slug}_${i}`,
        projectId: project.id,
      },
    });
  }
  return project.id;
}

describe("hasLegacyAlerts", () => {
  postgresTest("no legacy channels: both false", async ({ prisma }) => {
    const projectId = await seedProject(prisma, [["ERROR_GROUP"]]);
    expect(await hasLegacyAlerts(projectId, prisma)).toEqual({
      hasLegacyAlerts: false,
      hasMigratableLegacyAlerts: false,
    });
  });

  postgresTest("only coming-soon types: legacy but not migratable", async ({ prisma }) => {
    const projectId = await seedProject(prisma, [["DEPLOYMENT_FAILURE", "TASK_RUN_ATTEMPT"]]);
    expect(await hasLegacyAlerts(projectId, prisma)).toEqual({
      hasLegacyAlerts: true,
      hasMigratableLegacyAlerts: false,
    });
  });

  postgresTest("TASK_RUN: both true", async ({ prisma }) => {
    const projectId = await seedProject(prisma, [["DEPLOYMENT_SUCCESS"], ["TASK_RUN"]]);
    expect(await hasLegacyAlerts(projectId, prisma)).toEqual({
      hasLegacyAlerts: true,
      hasMigratableLegacyAlerts: true,
    });
  });
});
