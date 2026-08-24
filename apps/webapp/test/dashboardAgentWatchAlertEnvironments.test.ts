/**
 * One channel per (email, project) carries every environment the user subscribed from.
 * Subscribing in a second environment must add to that list: replacing it would stop the
 * first environment's mail without telling anyone.
 */

import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient, RuntimeEnvironment } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  actor: undefined as undefined | { userId: string; client?: string; environmentId?: string },
}));

vi.mock("~/services/uatRoutePreamble.server", () => ({
  authenticateUatOrApiRequest: async () =>
    ctx.actor
      ? {
          authenticationResult: {
            type: "personalAccessToken",
            result: { userId: ctx.actor.userId },
          },
          userActor: ctx.actor,
        }
      : undefined,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-alert-environments";
process.env.DASHBOARD_AGENT_SECRET_KEY = "tr_pat_test_dashboard_agent";
// The subscribe path refuses outright without an email transport configured.
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";

const { action: alertsAction } = await import("~/routes/api.v1.dashboard-agent.alerts");
const { DASHBOARD_AGENT_WATCH_ALERT_TYPE } =
  await import("~/services/dashboardAgentWatchAlerts.server");
const { DeliverDashboardAgentWatchAlertService } =
  await import("~/v3/services/alerts/deliverDashboardAgentWatchAlert.server");
const { alertsWorker } = await import("~/v3/alertsWorker.server");

const enqueue = alertsWorker.enqueue as unknown as ReturnType<typeof vi.fn>;

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  ctx.actor = undefined;
  enqueue.mockClear();
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** One organization with a production and a staging environment, and one member. */
async function seedProject(prisma: PrismaClient) {
  const slug = `alertenvs_${suffix()}`;
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = async (type: "PRODUCTION" | "STAGING", envSlug: string) =>
    prisma.runtimeEnvironment.create({
      data: {
        slug: envSlug,
        type,
        projectId: project.id,
        organizationId: organization.id,
        apiKey: `tr_${envSlug}_${slug}`,
        pkApiKey: `pk_${envSlug}_${slug}`,
        shortcode: `${envSlug.slice(0, 2)}${suffix()}`,
      },
    });
  const production = await environment("PRODUCTION", "prod");
  const staging = await environment("STAGING", "stg");

  const user = await prisma.user.create({
    data: { email: `member_${suffix()}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "MEMBER" },
  });

  return { organization, project, production, staging, user };
}

type Seeded = Awaited<ReturnType<typeof seedProject>>;

/** Subscribes through the real endpoint, in the environment the chat is open in. */
async function subscribeIn(
  seeded: Seeded,
  environment: RuntimeEnvironment,
  chatId: string
): Promise<Record<string, unknown>> {
  await createChat(ctx.agentDb, {
    id: chatId,
    organizationId: seeded.organization.id,
    userId: seeded.user.id,
  });

  ctx.actor = {
    userId: seeded.user.id,
    client: "dashboard-agent",
    environmentId: environment.id,
  };

  const response = (await alertsAction({
    request: new Request("https://app.trigger.dev/api/v1/dashboard-agent/alerts", {
      method: "POST",
      headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
      body: JSON.stringify({ chatId, channel: "email" }),
    }),
    params: {},
    context: {} as never,
  } as never)) as Response;

  expect(response.status).toBe(200);
  return (await response.json()) as Record<string, unknown>;
}

/** Runs the real fan-out for a watch that fired in this environment. */
async function fanOut(seeded: Seeded, environment: RuntimeEnvironment): Promise<string[]> {
  enqueue.mockClear();
  await new DeliverDashboardAgentWatchAlertService().call({
    watchId: `watch_${environment.slug}`,
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    environmentId: environment.id,
    userId: seeded.user.id,
    identity: "queue:my-queue",
    kind: "queue_depth",
    note: "the queue drains",
    firedAt: new Date().toISOString(),
    facts: { depth: 0 },
    resolution: "condition_met",
  } as never);

  return enqueue.mock.calls
    .map(([job]) => job as { payload?: { channelId?: string } })
    .flatMap((job) => (job.payload?.channelId ? [job.payload.channelId] : []));
}

describe("subscribing to watch alerts in a second environment", () => {
  postgresTest(
    "keeps the first environment's alerts delivering",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProject(prisma);

      const first = await subscribeIn(seeded, seeded.production, "chat_prod");
      expect(await fanOut(seeded, seeded.production)).toEqual([first.id]);

      const second = await subscribeIn(seeded, seeded.staging, "chat_staging");
      // The same channel, re-used through the per-email deduplication key.
      expect(second.id).toBe(first.id);

      // The point of the test: production still fans out after the staging subscribe.
      expect(await fanOut(seeded, seeded.production)).toEqual([first.id]);
      expect(await fanOut(seeded, seeded.staging)).toEqual([first.id]);

      const channels = await prisma.projectAlertChannel.findMany({
        where: { projectId: seeded.project.id },
        select: { environmentTypes: true, alertTypes: true, enabled: true },
      });
      expect(channels).toHaveLength(1);
      expect([...channels[0]!.environmentTypes].sort()).toEqual(["PRODUCTION", "STAGING"]);
      expect(channels[0]!.alertTypes).toEqual([DASHBOARD_AGENT_WATCH_ALERT_TYPE]);
    },
    60_000
  );

  postgresTest(
    "keeps an addition made between this subscribe's read and its write",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProject(prisma);

      await subscribeIn(seeded, seeded.production, "chat_prod");
      const channel = await prisma.projectAlertChannel.findFirstOrThrow({
        where: { projectId: seeded.project.id },
        select: { id: true },
      });

      // Stands in for a third environment whose subscribe commits after the staging
      // subscribe has read the row and before it writes it back.
      const read = prisma.projectAlertChannel.findFirst.bind(prisma.projectAlertChannel);
      let raced = false;
      const spy = vi
        .spyOn(prisma.projectAlertChannel, "findFirst")
        .mockImplementation(async (args: never) => {
          const result = await read(args);
          if (!raced && result) {
            raced = true;
            await prisma.projectAlertChannel.update({
              where: { id: channel.id },
              data: { environmentTypes: ["PRODUCTION", "DEVELOPMENT"] },
            });
          }
          return result;
        });

      try {
        await subscribeIn(seeded, seeded.staging, "chat_staging");
      } finally {
        spy.mockRestore();
      }
      expect(raced).toBe(true);

      const after = await prisma.projectAlertChannel.findFirstOrThrow({
        where: { id: channel.id },
        select: { environmentTypes: true },
      });
      expect([...after.environmentTypes].sort()).toEqual(["DEVELOPMENT", "PRODUCTION", "STAGING"]);
    },
    60_000
  );

  postgresTest(
    "leaves the other alert types on a channel it re-uses",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seedProject(prisma);

      await subscribeIn(seeded, seeded.production, "chat_prod");
      await prisma.projectAlertChannel.updateMany({
        where: { projectId: seeded.project.id },
        data: { alertTypes: ["TASK_RUN", DASHBOARD_AGENT_WATCH_ALERT_TYPE] },
      });

      await subscribeIn(seeded, seeded.staging, "chat_staging");

      const channel = await prisma.projectAlertChannel.findFirstOrThrow({
        where: { projectId: seeded.project.id },
        select: { alertTypes: true },
      });
      expect([...channel.alertTypes].sort()).toEqual(
        [DASHBOARD_AGENT_WATCH_ALERT_TYPE, "TASK_RUN"].sort()
      );
    },
    60_000
  );
});
