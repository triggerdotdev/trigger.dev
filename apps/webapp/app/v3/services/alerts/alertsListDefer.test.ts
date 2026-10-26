import { expect, vi } from "vitest";

vi.setConfig({ testTimeout: 60_000 });

vi.mock("~/env.server", () => ({ env: { ENCRYPTION_KEY: "test-key" } }));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: undefined }));
vi.mock("~/services/platform.v3.server", () => ({
  getLimit: async () => 100,
}));
vi.mock("~/services/secrets/secretStore.server", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, decryptSecret: async () => "decrypted" };
});

import { postgresTest } from "@internal/testcontainers";
import { AlertChannelListPresenter } from "~/presenters/v3/AlertChannelListPresenter.server";

postgresTest(
  "legacy path returns alertChannels and limits",
  async ({ prisma }) => {
    const org = await prisma.organization.create({
      data: { slug: "alerts-legacy-test", title: "Alerts legacy" },
    });
    const project = await prisma.project.create({
      data: {
        slug: "alerts-legacy-proj",
        name: "Alerts legacy proj",
        organizationId: org.id,
        externalRef: "alerts-legacy-ext",
      },
    });
    await prisma.projectAlertChannel.create({
      data: {
        friendlyId: "alert_chan_legacy_test",
        name: "Test channel",
        type: "EMAIL",
        projectId: project.id,
        alertTypes: ["TASK_RUN_ATTEMPT"],
        environmentTypes: ["PRODUCTION"],
        properties: { email: "test@example.com" },
      },
    });

    const presenter = new AlertChannelListPresenter(prisma, prisma);
    const data = await presenter.call(project.id, "PRODUCTION");

    expect(data.alertChannels.length).toBeGreaterThan(0);
    expect(data.alertChannels[0]!.name).toBe("Test channel");
    expect(data.limits).toEqual(
      expect.objectContaining({ used: expect.any(Number), limit: expect.any(Number) })
    );
  },
  120_000
);
