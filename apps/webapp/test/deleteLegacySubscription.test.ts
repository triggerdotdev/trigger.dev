import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, ProjectAlertType } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000 });

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

const { DeleteLegacySubscriptionService } =
  await import("~/v3/services/alerts/deleteLegacySubscription.server");

async function seed(prisma: PrismaClient, alertTypes: ProjectAlertType[]) {
  const slug = `delete_${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${slug}`,
      name: "Email to ops@example.com",
      type: "EMAIL",
      projectId: project.id,
      properties: { email: "ops@example.com" },
      alertTypes,
    },
  });
  return { project, channel };
}

function afterRead(prisma: PrismaClient, hook: () => Promise<void>): PrismaClient {
  const projectAlertChannel = new Proxy(prisma.projectAlertChannel, {
    get(target, key, receiver) {
      if (key !== "findFirst") return Reflect.get(target, key, receiver);
      return async (args: Parameters<typeof target.findFirst>[0]) => {
        const result = await target.findFirst(args);
        await hook();
        return result;
      };
    },
  });
  return new Proxy(prisma, {
    get(target, key, receiver) {
      if (key === "projectAlertChannel") return projectAlertChannel;
      return Reflect.get(target, key, receiver);
    },
  });
}

async function alertTypesOf(prisma: PrismaClient, id: string) {
  const channel = await prisma.projectAlertChannel.findUniqueOrThrow({ where: { id } });
  return channel.alertTypes;
}

describe("DeleteLegacySubscriptionService", () => {
  postgresTest("concurrent deletes of different types both stick", async ({ prisma }) => {
    const { project, channel } = await seed(prisma, ["TASK_RUN", "DEPLOYMENT_FAILURE"]);

    let reads = 0;
    let release!: () => void;
    const bothRead = new Promise<void>((resolve) => (release = resolve));
    const client = afterRead(prisma, async () => {
      if (++reads === 2) release();
      if (reads <= 2) await bothRead;
    });
    const service = new DeleteLegacySubscriptionService(client);

    const results = await Promise.all([
      service.call({ projectId: project.id, channelId: channel.id, alertType: "TASK_RUN" }),
      service.call({
        projectId: project.id,
        channelId: channel.id,
        alertType: "DEPLOYMENT_FAILURE",
      }),
    ]);

    expect(results).toEqual([{ deleted: true }, { deleted: true }]);
    expect(await alertTypesOf(prisma, channel.id)).toEqual([]);
  });

  postgresTest("does not restore a type removed between read and write", async ({ prisma }) => {
    const { project, channel } = await seed(prisma, [
      "TASK_RUN",
      "DEPLOYMENT_FAILURE",
      "DEPLOYMENT_SUCCESS",
    ]);

    let raced = false;
    const client = afterRead(prisma, async () => {
      if (raced) return;
      raced = true;
      await prisma.projectAlertChannel.update({
        where: { id: channel.id },
        data: { alertTypes: ["DEPLOYMENT_FAILURE", "DEPLOYMENT_SUCCESS"] },
      });
    });

    const result = await new DeleteLegacySubscriptionService(client).call({
      projectId: project.id,
      channelId: channel.id,
      alertType: "DEPLOYMENT_FAILURE",
    });

    expect(result).toEqual({ deleted: true });
    expect(await alertTypesOf(prisma, channel.id)).toEqual(["DEPLOYMENT_SUCCESS"]);
  });
});
