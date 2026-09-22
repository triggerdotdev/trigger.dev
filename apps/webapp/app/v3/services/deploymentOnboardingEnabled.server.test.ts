import { randomUUID } from "node:crypto";
import { postgresTest } from "@internal/testcontainers";
import { expect } from "vitest";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeSetFlag } from "~/v3/featureFlags.server";
import { deploymentOnboardingEnabled } from "./deploymentOnboardingEnabled.server";

postgresTest(
  "defaults off, applies org overrides in both directions and isolates organizations",
  async ({ prisma }) => {
    const [selected, other] = await Promise.all(
      ["Selected", "Other"].map((title) =>
        prisma.organization.create({ data: { title, slug: randomUUID() } })
      )
    );
    const key = FEATURE_FLAG.deployNowEnabled;
    const setGlobal = makeSetFlag(prisma);
    const selectedEnabled = () => deploymentOnboardingEnabled(selected.id, prisma);
    const otherEnabled = () => deploymentOnboardingEnabled(other.id, prisma);

    expect(await selectedEnabled()).toBe(false);
    await setGlobal({ key, value: false });
    await prisma.organization.update({
      where: { id: selected.id },
      data: { featureFlags: { [key]: true } },
    });
    expect(await selectedEnabled()).toBe(true);
    expect(await otherEnabled()).toBe(false);

    await setGlobal({ key, value: true });
    await prisma.organization.update({
      where: { id: selected.id },
      data: { featureFlags: { [key]: false } },
    });
    expect(await selectedEnabled()).toBe(false);
    expect(await otherEnabled()).toBe(true);
    expect(await deploymentOnboardingEnabled("missing-org", prisma)).toBe(false);

    // Preserve the app's strict catalog validation: strings do not become boolean overrides.
    await prisma.organization.update({
      where: { id: selected.id },
      data: { featureFlags: { [key]: "false" } },
    });
    expect(await selectedEnabled()).toBe(true);
    await setGlobal({ key, value: false });
    expect(await selectedEnabled()).toBe(false);
    expect(await deploymentOnboardingEnabled("missing-org", prisma)).toBe(false);
  }
);

postgresTest("a malformed sibling flag cannot discard a deployment opt-out", async ({ prisma }) => {
  const org = await prisma.organization.create({
    data: {
      title: "Opt out",
      slug: randomUUID(),
      featureFlags: { deployNowEnabled: false, dashboardAgentTurnEvalsEnabled: "false" },
    },
  });
  await makeSetFlag(prisma)({ key: FEATURE_FLAG.deployNowEnabled, value: true });
  expect(await deploymentOnboardingEnabled(org.id, prisma)).toBe(false);
  await prisma.organization.update({
    where: { id: org.id },
    data: {
      featureFlags: { deployNowEnabled: true, dashboardAgentTurnEvalsEnabled: "false" },
    },
  });
  await makeSetFlag(prisma)({ key: FEATURE_FLAG.deployNowEnabled, value: false });
  expect(await deploymentOnboardingEnabled(org.id, prisma)).toBe(true);
});
