import { postgresTest } from "@internal/testcontainers";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

const holder = vi.hoisted(() => ({ prisma: undefined as any }));

vi.mock("~/env.server", () => ({ env: { ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" } }));
vi.mock("~/db.server", () => {
  const proxy = new Proxy({}, { get: (_t, key) => holder.prisma[key] });
  return { prisma: proxy, $replica: proxy };
});
vi.mock("~/v3/alertsWorker.server", () => ({ alertsWorker: { enqueue: async () => {} } }));

const { CreateAlertChannelService } =
  await import("~/v3/services/alerts/createAlertChannel.server");

async function seed(prisma: any) {
  const slug = `p${Math.random().toString(36).slice(2, 8)}`;
  holder.prisma = prisma;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({
    data: { title: slug, slug, members: { create: { userId: user.id, role: "ADMIN" } } },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const secret = await prisma.secretReference.create({ data: { key: `secret_${slug}` } });
  const integration = await prisma.organizationIntegration.create({
    data: {
      friendlyId: `int_${slug}`,
      service: "SLACK",
      integrationData: {},
      tokenReferenceId: secret.id,
      organizationId: organization.id,
    },
  });
  return {
    userId: user.id,
    projectRef: project.externalRef,
    integrationId: integration.id,
    organizationId: organization.id,
  };
}

const base = { name: "n", alertTypes: ["TASK_RUN" as const], environmentTypes: [] };

describe("CreateAlertChannelService", () => {
  postgresTest("fails when the Slack integrationId column is not set", async ({ prisma }) => {
    const { userId, projectRef, integrationId } = await seed(prisma);
    const created = await new CreateAlertChannelService(prisma).call(projectRef, userId, {
      ...base,
      channel: { type: "SLACK", channelId: "C1", channelName: "ops", integrationId },
    });
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: created.id } });
    expect(row.integrationId).toBe(integrationId);
  });

  postgresTest("rejects a Slack integration from another organization", async ({ prisma }) => {
    const other = await seed(prisma);
    const { userId, projectRef } = await seed(prisma);
    await expect(
      new CreateAlertChannelService(prisma).call(projectRef, userId, {
        ...base,
        channel: {
          type: "SLACK",
          channelId: "C1",
          channelName: "ops",
          integrationId: other.integrationId,
        },
      })
    ).rejects.toThrow("Slack integration not found");
    expect(await prisma.projectAlertChannel.count()).toBe(0);
  });

  postgresTest("leaves the integrationId column null for email", async ({ prisma }) => {
    const { userId, projectRef } = await seed(prisma);
    const created = await new CreateAlertChannelService(prisma).call(projectRef, userId, {
      ...base,
      channel: { type: "EMAIL", email: "a@example.com" },
    });
    const row = await prisma.projectAlertChannel.findFirst({ where: { id: created.id } });
    expect(row.integrationId).toBeNull();
  });
});
