/**
 * A watch the sweep finalizes fires once, and the wake it then schedules reports the same
 * fired watch to the fire callback. Both fan out an alert, so exactly one of them may win
 * the dispatch claim — the count of enqueued alerts is what this file asserts.
 */

import {
  createChat,
  createDashboardAgentDb,
  createWatch,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  type Watch,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps } from "~/services/dashboardAgentWatchChecks";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
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

const SESSION_SECRET = "test-session-secret-for-watch-sweep-alerts";
process.env.SESSION_SECRET = SESSION_SECRET;

const { sweepDashboardAgentWatches } = await import("~/services/dashboardAgentWatchSweep.server");
const { action: firedAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.$watchId.fired");
const { signDashboardAgentWatchToken } = await import("~/services/dashboardAgentWatchToken.server");
const { alertsWorker } = await import("~/v3/alertsWorker.server");

const enqueue = alertsWorker.enqueue as unknown as ReturnType<typeof vi.fn>;

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

beforeEach(() => {
  enqueue.mockClear();
});

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** A real org, project, environment and member: the sweep and the callback both re-authorize. */
async function seed(prisma: PrismaClient) {
  const slug = `sweep_alert_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
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
      shortcode: `pr${suffix()}`,
    },
  });

  const chatId = `chat_${suffix()}`;
  await createChat(ctx.agentDb, {
    id: chatId,
    organizationId: organization.id,
    userId: user.id,
  });

  return { user, organization, project, environment, chatId };
}

/** Below its threshold on the boundary check, so the sweep resolves it `condition_met`. */
const DRAINING: WatchSpec = {
  kind: "queue_depth_below",
  queue: "task/send-receipt",
  threshold: 10,
  checkEveryMinutes: 5,
  maxHours: 1,
  note: "tell me when it drains",
};

function checkDeps(): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => ({ depth: 0, source: "live_queue", current: true }),
    readQueueOldestAge: async () => null,
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
  };
}

function firedRequest(watchId: string, token: string) {
  return {
    request: new Request(
      `https://app.trigger.dev/api/v1/dashboard-agent/watches/${watchId}/fired`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` } }
    ),
    params: { watchId },
    context: {} as never,
  } as never;
}

function alertCalls() {
  return enqueue.mock.calls.filter(
    (call) => (call[0] as { job: string }).job === "v3.deliverDashboardAgentWatchAlert"
  );
}

describe("a watch the sweep finalizes", () => {
  postgresTest(
    "alerts exactly once, however the wake reports it afterwards",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const created = await createWatch(ctx.agentDb, {
        chatId: seeded.chatId,
        identity: "queue_depth_below:task/send-receipt:10",
        spec: DRAINING as never,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
        userId: seeded.user.id,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      if (!created.ok) throw new Error(`the watch wasn't created: ${created.error}`);

      // Past the sweep's grace window, so this run owns the final evaluation.
      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 hour' where id = $1`,
        created.watch.id
      );

      const token = await signDashboardAgentWatchToken(SESSION_SECRET, {
        watchId: created.watch.id,
        expiresAt: new Date(Date.now() + 60_000),
      });

      // The wake the sweep schedules ends at the fire callback, which fans out again.
      const result = await sweepDashboardAgentWatches({
        checkDeps: () => checkDeps(),
        configured: () => true,
        deliver: async (watch: Watch) => {
          const response = (await firedAction(firedRequest(watch.id, token))) as Response;
          expect(response.status).toBe(200);
        },
      });

      expect(result).toMatchObject({ overdue: 1, fired: 1, failed: 0 });
      expect(alertCalls()).toHaveLength(1);
    }
  );
});
