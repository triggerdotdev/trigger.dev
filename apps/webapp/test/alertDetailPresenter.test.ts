import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, RuntimeEnvironmentType } from "@trigger.dev/database";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { appendAlertEvent, createAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { startAlertsPostgres } from "./helpers/alertTables";
import { AlertDetailPresenter } from "~/presenters/v3/AlertDetailPresenter.server";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

describe("AlertDetailPresenter occurrenceCount", () => {
  it("counts raised events for a threshold alert whose occurrencesTotal is 0", async () => {
    const alert = await createAlert(db, {
      organizationId: "org_1",
      projectId: "proj_1",
      environmentId: "env_1",
      createdBy: "user_1",
      capabilityKey: "queue.depth",
      params: { environmentId: "env_1", scope: { type: "all" } },
      condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
      name: "depth",
      notifiers: [],
    });
    for (let i = 0; i < 3; i++) {
      await appendAlertEvent(db, {
        alertId: alert.id,
        type: "raised",
        at: new Date(Date.now() - (i + 1) * 60_000),
      });
    }
    await appendAlertEvent(db, { alertId: alert.id, type: "recovered", at: new Date() });

    const presenter = new AlertDetailPresenter(db, {} as never);
    const detail = await presenter.call({
      id: alert.id,
      projectId: "proj_1",
      environmentId: "env_1",
    });

    expect(detail?.occurrenceCount).toBe(3);
  });
});

async function detailWithChannel(
  prisma: PrismaClient,
  environmentTypes: RuntimeEnvironmentType[],
  lifecycle: "active" | "stopped" = "active"
) {
  const slug = `d${Math.random().toString(36).slice(2, 10)}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "prod",
      type: "PRODUCTION",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_prod_${slug}`,
      pkApiKey: `pk_prod_${slug}`,
      shortcode: slug,
    },
  });
  const channel = await prisma.projectAlertChannel.create({
    data: {
      friendlyId: `alert_channel_${slug}`,
      name: "ops",
      type: "EMAIL",
      projectId: project.id,
      properties: { email: "ops@example.com" },
      alertTypes: [],
      environmentTypes,
    },
  });
  const alert = await createAlert(db, {
    organizationId: organization.id,
    projectId: project.id,
    environmentId: environment.id,
    createdBy: "user_1",
    capabilityKey: "queue.depth",
    params: { environmentId: environment.id, scope: { type: "all" } },
    condition: { kind: "threshold", operator: ">", value: 10, windowSec: 60 },
    lifecycle,
    name: "depth",
    notifiers: [{ type: "channel", channelId: channel.id }],
  });
  const detail = await new AlertDetailPresenter(
    db,
    prisma,
    undefined,
    async () => null,
    async () => null,
    {
      evaluateBinding: async () => ({
        result: { kind: "stateful", outcome: "not_met", facts: {} },
      }),
    }
  ).call({
    id: alert.id,
    projectId: project.id,
    environmentId: environment.id,
  });
  return { detail, channel };
}

describe("AlertDetailPresenter channel issues", () => {
  postgresTest("flags a channel that does not deliver for the environment", async ({ prisma }) => {
    const { detail, channel } = await detailWithChannel(prisma, ["STAGING"]);
    expect(detail?.channelIssues).toEqual([
      { channelId: channel.id, name: "ops", reason: "environment" },
    ]);
    expect(detail?.status).toEqual({ status: "active" });
    expect(detail?.thresholdValue).toBe(10);
    expect(detail?.notifiers).toEqual([{ key: `channel:${channel.id}`, label: "ops" }]);
  });

  postgresTest("stays active when the channel delivers", async ({ prisma }) => {
    const { detail } = await detailWithChannel(prisma, ["PRODUCTION"]);
    expect(detail?.channelIssues).toEqual([]);
    expect(detail?.status).toEqual({ status: "active" });
  });

  postgresTest("keeps an inactive alert inactive", async ({ prisma }) => {
    const { detail } = await detailWithChannel(prisma, ["STAGING"], "stopped");
    expect(detail?.channelIssues).toHaveLength(1);
    expect(detail?.status).toEqual({ status: "inactive", reason: "stopped" });
  });
});
