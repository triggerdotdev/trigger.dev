import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";
import { queueArchivingEnabled } from "./queueArchivingEnabled.server";

postgresTest("defaults off and can be enabled for a single organization", async ({ prisma }) => {
  const [selected, other] = await Promise.all(
    ["Selected", "Other"].map((title) =>
      prisma.organization.create({ data: { title, slug: randomUUID() } })
    )
  );
  const key = FEATURE_FLAG.queueArchivingEnabled;

  expect(await queueArchivingEnabled(selected.id, { client: prisma })).toBe(false);

  await prisma.organization.update({
    where: { id: selected.id },
    data: { featureFlags: { [key]: true } },
  });
  expect(await queueArchivingEnabled(selected.id, { client: prisma })).toBe(true);
  expect(await queueArchivingEnabled(other.id, { client: prisma })).toBe(false);

  await makeSetFlag(prisma)({ key, value: true });
  expect(await queueArchivingEnabled(other.id, { client: prisma })).toBe(true);
  expect(await queueArchivingEnabled("missing-org", { client: prisma })).toBe(false);
});
