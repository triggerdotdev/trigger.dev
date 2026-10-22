import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";
import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { findSlackIntegration } from "./alertTransport.server";

vi.setConfig({ testTimeout: 60_000 });

async function seed(prisma: any, deleted: boolean) {
  const organization = await prisma.organization.create({
    data: { slug: "slack-lookup", title: "Slack lookup" },
  });
  const secret = await prisma.secretReference.create({ data: { key: "slack-lookup-token" } });
  const integration = await prisma.organizationIntegration.create({
    data: {
      friendlyId: generateFriendlyId("org_integration"),
      service: "SLACK",
      integrationData: {},
      tokenReferenceId: secret.id,
      organizationId: organization.id,
      deletedAt: deleted ? new Date() : null,
    },
  });
  return { organization, integration };
}

postgresTest("resolves a live Slack integration by id and by organization", async ({ prisma }) => {
  const { organization, integration } = await seed(prisma, false);

  const byId = await findSlackIntegration(prisma, {
    integrationId: integration.id,
    organizationId: organization.id,
  });
  const byOrg = await findSlackIntegration(prisma, { organizationId: organization.id });

  expect(byId?.id).toBe(integration.id);
  expect(byOrg?.id).toBe(integration.id);
});

postgresTest("ignores a soft-deleted Slack integration", async ({ prisma }) => {
  const { organization, integration } = await seed(prisma, true);

  expect(
    await findSlackIntegration(prisma, {
      integrationId: integration.id,
      organizationId: organization.id,
    })
  ).toBeNull();
  expect(await findSlackIntegration(prisma, { organizationId: organization.id })).toBeNull();
});

postgresTest(
  "resolves a soft-deleted integration by id when includeDeleted is set",
  async ({ prisma }) => {
    const { organization, integration } = await seed(prisma, true);

    const byId = await findSlackIntegration(
      prisma,
      { integrationId: integration.id, organizationId: organization.id },
      { includeDeleted: true }
    );

    expect(byId?.id).toBe(integration.id);
  }
);

postgresTest(
  "resolves a soft-deleted integration by organization when includeDeleted is set",
  async ({ prisma }) => {
    const { organization, integration } = await seed(prisma, true);

    const byOrg = await findSlackIntegration(
      prisma,
      { organizationId: organization.id },
      { includeDeleted: true }
    );

    expect(byOrg?.id).toBe(integration.id);
  }
);

postgresTest(
  "prefers an older live integration over a newer soft-deleted one when includeDeleted is set",
  async ({ prisma }) => {
    const { organization, integration: live } = await seed(prisma, false);
    const secret = await prisma.secretReference.create({ data: { key: "slack-lookup-token-2" } });
    await prisma.organizationIntegration.create({
      data: {
        friendlyId: generateFriendlyId("org_integration"),
        service: "SLACK",
        integrationData: {},
        tokenReferenceId: secret.id,
        organizationId: organization.id,
        createdAt: new Date(Date.now() + 60_000),
        deletedAt: new Date(),
      },
    });

    const byOrg = await findSlackIntegration(
      prisma,
      { organizationId: organization.id },
      { includeDeleted: true }
    );

    expect(byOrg?.id).toBe(live.id);
  }
);
