import type * as SafeWebhookUrlModule from "~/v3/services/alerts/safeWebhookUrl.server";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { describe, expect, it, vi } from "vitest";
import { UpdateAlertChannelService } from "~/v3/services/alerts/updateAlertChannel.server";

vi.mock("~/v3/services/alerts/safeWebhookUrl.server", async (importOriginal) => {
  const actual = await importOriginal<typeof SafeWebhookUrlModule>();
  return {
    ...actual,
    assertSafeWebhookUrl: async (url: string) => actual.assertSafeWebhookUrlLexical(url),
  };
});

const storedSecret = { nonce: "n1", ciphertext: "c1", tag: "t1" };

const integrations = [
  { id: "int_1", service: "SLACK", organizationId: "o1", deletedAt: null },
  { id: "int_other", service: "SLACK", organizationId: "o2", deletedAt: null },
];

const authorized: RuntimeEnvironmentType[] = ["PRODUCTION"];

function fakePrisma(row: Record<string, unknown>) {
  const stored = { environmentTypes: authorized, ...row };
  const update = vi.fn(async ({ where }: any) => ({
    count:
      where.id === stored.id &&
      where.projectId === stored.projectId &&
      where.environmentTypes.equals.join() === stored.environmentTypes.join()
        ? 1
        : 0,
  }));
  const prisma = {
    organizationIntegration: {
      findFirst: vi.fn(
        async ({ where }: any) =>
          integrations.find((i) =>
            Object.entries(where).every(([k, v]) => (i as Record<string, unknown>)[k] === v)
          ) ?? null
      ),
    },
    projectAlertChannel: {
      findFirst: vi.fn(async ({ where }: any) =>
        where.id === stored.id && where.projectId === stored.projectId
          ? { ...stored, project: { organizationId: "o1" } }
          : null
      ),
      updateMany: update,
    },
  };
  return { prisma: prisma as any, update };
}

describe("UpdateAlertChannelService", () => {
  it("fails when the webhook secret is regenerated on edit", async () => {
    const { prisma, update } = fakePrisma({
      id: "c1",
      projectId: "p1",
      type: "WEBHOOK",
      alertTypes: ["TASK_RUN"],
      environmentTypes: ["PRODUCTION"],
      properties: { url: "https://old.example.com/hook", secret: storedSecret, version: "v2" },
    });

    await new UpdateAlertChannelService(prisma).call(
      "p1",
      "c1",
      {
        name: "Webhook to new.example.com",
        channel: { type: "WEBHOOK", url: "https://new.example.com/hook" },
      },
      authorized
    );

    expect(update).toHaveBeenCalledWith({
      where: { id: "c1", projectId: "p1", environmentTypes: { equals: authorized } },
      data: {
        name: "Webhook to new.example.com",
        properties: { url: "https://new.example.com/hook", secret: storedSecret, version: "v2" },
      },
    });
  });

  it("fails when a channel from another project can be edited", async () => {
    const { prisma, update } = fakePrisma({
      id: "c1",
      projectId: "p1",
      type: "EMAIL",
      properties: { email: "a@example.com" },
    });

    await expect(
      new UpdateAlertChannelService(prisma).call(
        "p2",
        "c1",
        {
          name: "Email to b@example.com",
          channel: { type: "EMAIL", email: "b@example.com" },
        },
        authorized
      )
    ).rejects.toThrow("Alert channel not found");
    expect(update).not.toHaveBeenCalled();
  });

  it("fails when the channel type can be changed", async () => {
    const { prisma, update } = fakePrisma({
      id: "c1",
      projectId: "p1",
      type: "EMAIL",
      properties: { email: "a@example.com" },
    });

    await expect(
      new UpdateAlertChannelService(prisma).call(
        "p1",
        "c1",
        {
          name: "Webhook to new.example.com",
          channel: { type: "WEBHOOK", url: "https://new.example.com/hook" },
        },
        authorized
      )
    ).rejects.toThrow("Changing the channel type is not supported");
    expect(update).not.toHaveBeenCalled();
  });

  it("fails when an unsafe webhook url is accepted on update", async () => {
    const { prisma, update } = fakePrisma({
      id: "c1",
      projectId: "p1",
      type: "WEBHOOK",
      properties: { url: "https://old.example.com/hook", secret: storedSecret, version: "v2" },
    });

    await expect(
      new UpdateAlertChannelService(prisma).call(
        "p1",
        "c1",
        {
          name: "Webhook to 169.254.169.254",
          channel: { type: "WEBHOOK", url: "http://169.254.169.254/latest" },
        },
        authorized
      )
    ).rejects.toThrow();
    expect(update).not.toHaveBeenCalled();
  });

  it("keeps the stored Slack integration when the update omits it", async () => {
    const { prisma, update } = fakePrisma({
      id: "c2",
      projectId: "p1",
      type: "SLACK",
      alertTypes: [],
      environmentTypes: ["PRODUCTION"],
      properties: { channelId: "C1", channelName: "ops", integrationId: "int_1" },
    });

    await new UpdateAlertChannelService(prisma).call(
      "p1",
      "c2",
      {
        name: "Slack message to ops",
        channel: { type: "SLACK", channelId: "C1", channelName: "ops" },
        environmentTypes: ["STAGING"],
      },
      authorized
    );

    expect(update.mock.calls[0][0].data.environmentTypes).toEqual(["STAGING"]);
    expect(update.mock.calls[0][0].data.properties.integrationId).toBe("int_1");
  });

  it("fails when the integrationId column is not healed on a Slack update", async () => {
    const { prisma, update } = fakePrisma({
      id: "c3",
      projectId: "p1",
      type: "SLACK",
      integrationId: null,
      properties: { channelId: "C1", channelName: "ops", integrationId: "int_1" },
    });

    await new UpdateAlertChannelService(prisma).call(
      "p1",
      "c3",
      {
        name: "Slack message to ops",
        channel: { type: "SLACK", channelId: "C1", channelName: "ops" },
      },
      authorized
    );

    expect(update.mock.calls[0][0].data.integrationId).toBe("int_1");
  });

  it("rejects a Slack integration from another organization", async () => {
    const { prisma, update } = fakePrisma({
      id: "c4",
      projectId: "p1",
      type: "SLACK",
      properties: { channelId: "C1", channelName: "ops", integrationId: "int_1" },
    });

    await expect(
      new UpdateAlertChannelService(prisma).call(
        "p1",
        "c4",
        {
          name: "Slack message to ops",
          channel: {
            type: "SLACK",
            channelId: "C1",
            channelName: "ops",
            integrationId: "int_other",
          },
        },
        authorized
      )
    ).rejects.toThrow("Slack integration not found");
    expect(update).not.toHaveBeenCalled();
  });

  it("stores a Slack integration from the same organization", async () => {
    const { prisma, update } = fakePrisma({
      id: "c5",
      projectId: "p1",
      type: "SLACK",
      properties: { channelId: "C1", channelName: "ops" },
    });

    await new UpdateAlertChannelService(prisma).call(
      "p1",
      "c5",
      {
        name: "Slack message to ops",
        channel: { type: "SLACK", channelId: "C1", channelName: "ops", integrationId: "int_1" },
      },
      authorized
    );

    expect(update.mock.calls[0][0].data.integrationId).toBe("int_1");
  });

  it("writes nothing when the authorized environments no longer match", async () => {
    const { prisma, update } = fakePrisma({
      id: "c6",
      projectId: "p1",
      type: "EMAIL",
      environmentTypes: ["PRODUCTION", "DEVELOPMENT"],
      properties: { email: "a@example.com" },
    });

    const result = await new UpdateAlertChannelService(prisma).call(
      "p1",
      "c6",
      { name: "Email to b@example.com", channel: { type: "EMAIL", email: "b@example.com" } },
      ["DEVELOPMENT"]
    );

    expect(result).toBeNull();
    expect(update).toHaveBeenCalledTimes(1);
    expect(prisma.projectAlertChannel.findFirst).toHaveBeenCalledTimes(1);
  });
});
