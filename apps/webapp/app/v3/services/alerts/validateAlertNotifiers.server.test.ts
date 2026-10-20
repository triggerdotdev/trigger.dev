import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(() => ({ prisma: undefined as unknown as PrismaClient }));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));

import { generateFriendlyId } from "~/v3/friendlyIdentifiers";
import { validateAlertNotifiers } from "./validateAlertNotifiers.server";

postgresTest("rejects a channel for another environment type", async ({ prisma }) => {
  ctx.prisma = prisma;
  const organization = await prisma.organization.create({
    data: { slug: "validate-notifiers", title: "Validate notifiers" },
  });
  const project = await prisma.project.create({
    data: {
      slug: "validate-notifiers",
      name: "Validate notifiers",
      externalRef: "validate-notifiers",
      organizationId: organization.id,
    },
  });

  const make = (name: string, environmentTypes: ("PRODUCTION" | "DEVELOPMENT")[]) =>
    prisma.projectAlertChannel.create({
      data: {
        friendlyId: generateFriendlyId("alert_channel"),
        projectId: project.id,
        type: "EMAIL",
        name,
        properties: { email: `${name}@example.test` },
        alertTypes: ["TASK_RUN"],
        environmentTypes,
      },
    });

  const prod = await make("prod", ["PRODUCTION"]);
  const dev = await make("dev", ["DEVELOPMENT"]);

  const check = (channelId: string) =>
    validateAlertNotifiers({
      notifiers: [{ type: "channel", channelId }],
      projectId: project.id,
      organizationId: organization.id,
      userId: "user",
      environmentType: "PRODUCTION",
    });

  expect(await check(prod.id)).toBeNull();
  expect(await check(dev.id)).toMatchObject({ reason: "channel" });
});
