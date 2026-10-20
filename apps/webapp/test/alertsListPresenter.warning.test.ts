import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterAll, beforeAll, describe, expect, vi } from "vitest";
import { createAlert } from "~/v3/services/alerts/storage/alertStore.server";
import { startAlertsPostgres } from "./helpers/alertTables";
import { AlertDetailPresenter } from "~/presenters/v3/AlertDetailPresenter.server";
import { AlertsListPresenter } from "~/presenters/v3/AlertsListPresenter.server";

vi.setConfig({ testTimeout: 120_000 });

let pg: Awaited<ReturnType<typeof startAlertsPostgres>>;
let db: PrismaClient;

beforeAll(async () => {
  pg = await startAlertsPostgres();
  db = pg.prisma;
}, 120_000);

afterAll(async () => {
  await pg?.stop();
});

async function seed(prisma: PrismaClient) {
  const slug = `w${Math.random().toString(36).slice(2, 10)}`;
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
      environmentTypes: ["STAGING"],
    },
  });
  return { organization, project, environment, channel };
}

const NO_FILTERS = { search: "", areas: [], period: undefined };

describe("AlertsListPresenter status and channel issue flag", () => {
  postgresTest(
    "a raised alert with a broken channel still filters as needs attention",
    async ({ prisma }) => {
      const { organization, project, environment, channel } = await seed(prisma);
      await createAlert(db, {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: environment.id,
        createdBy: "user_1",
        capabilityKey: "queue.depth",
        params: { queue: "worker-1" },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        attention: "needs_attention",
        name: "raised",
        notifiers: [{ type: "channel", channelId: channel.id }],
      });
      const presenter = new AlertsListPresenter(db, prisma);
      const list = (statuses: ("needs_attention" | "active" | "inactive")[]) =>
        presenter
          .call({ environmentId: environment.id, filters: { ...NO_FILTERS, statuses } })
          .then((r) => r.rows.map((row) => row.name));

      const { rows } = await presenter.call({ environmentId: environment.id });
      expect(rows[0]).toMatchObject({ status: "needs_attention", hasChannelIssue: true });
      expect(await list(["needs_attention"])).toEqual(["raised"]);
      expect(await list(["active"])).toEqual([]);
    }
  );

  postgresTest(
    "reports a deleted channel when the environment is not found",
    async ({ prisma }) => {
      const { organization, project } = await seed(prisma);
      const alert = await createAlert(db, {
        organizationId: organization.id,
        projectId: project.id,
        environmentId: "env_missing",
        createdBy: "user_1",
        capabilityKey: "queue.depth",
        params: { environmentId: "env_missing", scope: { type: "all" } },
        condition: { kind: "threshold", operator: ">", value: 100, windowSec: 300 },
        name: "orphan",
        notifiers: [{ type: "channel", channelId: "chan_deleted" }],
      });

      const { rows } = await new AlertsListPresenter(db, prisma).call({
        environmentId: "env_missing",
      });
      expect(rows[0]).toMatchObject({ status: "active", hasChannelIssue: true });

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
      ).call({ id: alert.id, projectId: project.id, environmentId: "env_missing" });
      expect(detail?.channelIssues).toEqual([
        { channelId: "chan_deleted", name: null, reason: "deleted" },
      ]);
      expect(detail?.status).toEqual({ status: "active" });
    }
  );
});
