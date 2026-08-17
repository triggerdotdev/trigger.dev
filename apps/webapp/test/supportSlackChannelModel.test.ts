import { postgresTest } from "@internal/testcontainers";
import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

postgresTest("round-trips a LINKED support channel row", async ({ prisma }) => {
  const org = await prisma.organization.create({ data: { title: "Acme", slug: "acme" } });
  await prisma.organizationSupportChannel.create({
    data: {
      organizationId: org.id,
      status: "LINKED",
      slackChannelId: "C123",
      slackChannelName: "cus-acme",
    },
  });
  const row = await prisma.organizationSupportChannel.findFirst({
    where: { organizationId: org.id },
  });
  expect(row?.status).toBe("LINKED");
  expect(row?.slackChannelId).toBe("C123");
});

postgresTest("one row per org (organizationId unique)", async ({ prisma }) => {
  const org = await prisma.organization.create({ data: { title: "B", slug: "b" } });
  await prisma.organizationSupportChannel.create({
    data: { organizationId: org.id, status: "PENDING" },
  });
  await expect(
    prisma.organizationSupportChannel.create({
      data: { organizationId: org.id, status: "PENDING" },
    })
  ).rejects.toThrow();
});

postgresTest("one org per channel (slackChannelId unique, nulls allowed)", async ({ prisma }) => {
  const a = await prisma.organization.create({ data: { title: "A2", slug: "a2" } });
  const b = await prisma.organization.create({ data: { title: "B2", slug: "b2" } });
  await prisma.organizationSupportChannel.create({
    data: { organizationId: a.id, status: "LINKED", slackChannelId: "C9" },
  });
  await expect(
    prisma.organizationSupportChannel.create({
      data: { organizationId: b.id, status: "LINKED", slackChannelId: "C9" },
    })
  ).rejects.toThrow();
  // multiple NULL slackChannelIds must coexist
  await prisma.organizationSupportChannel.deleteMany({});
  await prisma.organizationSupportChannel.create({
    data: { organizationId: a.id, status: "PENDING" },
  });
  await prisma.organizationSupportChannel.create({
    data: { organizationId: b.id, status: "PENDING" },
  });
});
