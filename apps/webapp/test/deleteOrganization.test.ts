import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { beforeEach, describe, expect, vi } from "vitest";
import { DeleteOrganizationService } from "~/services/deleteOrganization.server";
import { createTestUser, uniqueId } from "./fixtures/environmentVariablesFixtures";

const { getCurrentPlanOrThrowMock, cancelSubscriptionMock } = vi.hoisted(() => ({
  getCurrentPlanOrThrowMock: vi.fn(async (_orgId: string): Promise<unknown> => undefined),
  cancelSubscriptionMock: vi.fn(async (_orgId: string): Promise<unknown> => undefined),
}));

vi.mock("~/services/platform.v3.server", async (importOriginal) => {
  const mod = (await importOriginal()) as Record<string, unknown>;
  return {
    ...mod,
    getCurrentPlanOrThrow: getCurrentPlanOrThrowMock,
    cancelSubscription: cancelSubscriptionMock,
  };
});

vi.mock("~/v3/commonWorker.server", () => ({
  commonWorker: { enqueue: async () => undefined },
}));

vi.setConfig({ testTimeout: 60_000 });

async function createOrg(prisma: PrismaClient) {
  const user = await createTestUser(prisma);
  const organization = await prisma.organization.create({
    data: {
      title: "Test Org",
      slug: uniqueId("org"),
      members: { create: { userId: user.id, role: "ADMIN" } },
    },
  });
  return { user, organization };
}

async function deleteOrg(prisma: PrismaClient, slug: string, userId: string) {
  return new DeleteOrganizationService(prisma).call({
    organizationSlug: slug,
    userId,
    request: new Request("https://cloud.trigger.dev/"),
  });
}

function plan(v3Subscription: Record<string, unknown>) {
  return { success: true, v3Subscription: { freeTierStatus: "approved", ...v3Subscription } };
}

describe("DeleteOrganizationService billing", () => {
  beforeEach(() => {
    getCurrentPlanOrThrowMock.mockReset();
    cancelSubscriptionMock.mockReset();
  });

  postgresTest("aborts when the plan lookup fails", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockRejectedValue(new Error("billing down"));

    await expect(deleteOrg(prisma, organization.slug, user.id)).rejects.toThrow(
      "Couldn't verify billing state, try again"
    );

    expect(cancelSubscriptionMock).not.toHaveBeenCalled();
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeNull();
  });

  postgresTest("cancels a paid subscription then deletes", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockResolvedValue(plan({ isPaying: true }));
    cancelSubscriptionMock.mockResolvedValue({
      success: true,
      outcome: "canceled",
      cancelAt: null,
    });

    await deleteOrg(prisma, organization.slug, user.id);

    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(organization.id);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeInstanceOf(Date);
  });

  postgresTest("aborts when the cancel call returns an error", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockResolvedValue(plan({ isPaying: true }));
    cancelSubscriptionMock.mockResolvedValue({ success: false, error: "stripe_error" });

    await expect(deleteOrg(prisma, organization.slug, user.id)).rejects.toThrow(
      "Couldn't cancel the subscription, try again"
    );

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeNull();
  });

  postgresTest("aborts when the cancel call throws", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockResolvedValue(plan({ isPaying: true }));
    cancelSubscriptionMock.mockRejectedValue(new Error("network down"));

    await expect(deleteOrg(prisma, organization.slug, user.id)).rejects.toThrow(
      "Couldn't cancel the subscription, try again"
    );

    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeNull();
  });

  postgresTest("deletes when the subscription is already canceled", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockResolvedValue(plan({ isPaying: true }));
    cancelSubscriptionMock.mockResolvedValue({
      success: true,
      outcome: "already_canceled",
      cancelAt: null,
    });

    await deleteOrg(prisma, organization.slug, user.id);

    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeInstanceOf(Date);
  });

  postgresTest("asks billing to cancel even when not paying", async ({ prisma }) => {
    const { user, organization } = await createOrg(prisma);
    getCurrentPlanOrThrowMock.mockResolvedValue(plan({ isPaying: false }));
    cancelSubscriptionMock.mockResolvedValue({
      success: true,
      outcome: "no_subscription",
      cancelAt: null,
    });

    await deleteOrg(prisma, organization.slug, user.id);

    expect(cancelSubscriptionMock).toHaveBeenCalledTimes(1);
    expect(cancelSubscriptionMock).toHaveBeenCalledWith(organization.id);
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organization.id } });
    expect(org.deletedAt).toBeInstanceOf(Date);
  });
});
