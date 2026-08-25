import {
  createChat,
  createDashboardAgentDb,
  createWatch,
  getWatch,
  recordWatchCheck,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  type Watch,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps } from "~/services/dashboardAgentWatchChecks";

// The boundary evaluation the sweep runs is a real check: it sees the streak the ticks
// built, and one incident's worth of expiries must not re-read the same authorization.

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

vi.mock("~/services/dashboardAgentWatchAlerts.server", () => ({
  DASHBOARD_AGENT_WATCH_ALERT_TYPE: "DASHBOARD_AGENT_WATCH",
  enqueueWatchFiredAlert: async () => {},
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-sweep";

const { sweepDashboardAgentWatches } = await import("~/services/dashboardAgentWatchSweep.server");

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
  ctx.agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

const ORGANIZATION_ID = "org_sweep";
const PROJECT_ID = "proj_sweep";
const ENVIRONMENT_ID = "env_sweep";
const USER_ID = "user_sweep";

const environment = {
  id: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: "prod",
  type: "PRODUCTION",
  project: { id: PROJECT_ID, externalRef: "proj_external" },
  organization: { id: ORGANIZATION_ID, slug: "sweep" },
} as any;

/** The stall spec the boundary check has to decide: three no-progress checks in a row. */
const STALLED: WatchSpec = {
  kind: "queue_stalled",
  queue: "task/send-receipt",
  ticks: 3,
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me if the queue stops moving",
};

async function seedOverdueWatch(args: {
  chatId: string;
  spec?: WatchSpec;
  identity?: string;
  userId?: string;
  lastResult?: Record<string, unknown>;
}): Promise<string> {
  const created = await createWatch(ctx.agentDb, {
    chatId: args.chatId,
    identity: args.identity ?? `queue_stalled:${args.chatId}`,
    spec: (args.spec ?? STALLED) as any,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    userId: args.userId ?? USER_ID,
    expiresAt: new Date(Date.now() + 60 * 60 * 1000),
  });
  if (!created.ok) throw new Error(`the watch wasn't created: ${created.error}`);

  if (args.lastResult) {
    await recordWatchCheck(ctx.agentDb, { id: created.watch.id, lastResult: args.lastResult });
  }
  // Past the sweep's grace window, so this run owns the final evaluation.
  await ctx.prisma.$executeRawUnsafe(
    `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 hour' where id = $1`,
    created.watch.id
  );
  return created.watch.id;
}

function checkDepsWithDepth(depth: number): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => ({ depth, source: "live_queue", current: true }),
    readQueueOldestAge: async () => null,
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
  };
}

describe("the sweep's boundary evaluation", () => {
  postgresTest(
    "fires a stall the final check completes, because it carries the streak the ticks built",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(ctx.agentDb, {
        id: "chat_stall",
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
      });

      // Two no-progress checks are already recorded, so a third at the same depth is the
      // stall: the transition happens exactly on the window boundary.
      const watchId = await seedOverdueWatch({
        chatId: "chat_stall",
        lastResult: {
          result: "pending",
          facts: {
            queue: "task/send-receipt",
            depth: 412,
            notDecreasingStreak: 2,
            ticks: 3,
          },
        },
      });

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches({
        checkDeps: () => checkDepsWithDepth(412),
        authorize: async () => ({ ok: true, environment }) as const,
        deliver: async (watch: Watch) => void delivered.push(watch.id),
        configured: () => true,
      });

      expect(result).toMatchObject({ overdue: 1, fired: 1, expired: 0, failed: 0 });
      const row = await getWatch(ctx.agentDb, { id: watchId });
      expect(row).toMatchObject({ status: "fired", resolution: "condition_met" });
      // The facts the wake narrates are the streak that closed, not a reset one.
      const facts = row?.lastResult as { notDecreasingStreak?: number } | undefined;
      expect(facts?.notDecreasingStreak).toBe(3);
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "still completes the window when the streak is one short of the stall",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      await createChat(ctx.agentDb, {
        id: "chat_no_stall",
        organizationId: ORGANIZATION_ID,
        userId: USER_ID,
      });

      const watchId = await seedOverdueWatch({
        chatId: "chat_no_stall",
        lastResult: {
          result: "pending",
          facts: { queue: "task/send-receipt", depth: 412, notDecreasingStreak: 1, ticks: 3 },
        },
      });

      const result = await sweepDashboardAgentWatches({
        checkDeps: () => checkDepsWithDepth(412),
        authorize: async () => ({ ok: true, environment }) as const,
        deliver: async () => {},
        configured: () => true,
      });

      expect(result).toMatchObject({ overdue: 1, fired: 0, expired: 1, failed: 0 });
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        resolution: "window_completed",
      });
    }
  );
});

describe("the sweep's reads per incident", () => {
  postgresTest(
    "re-authorizes and builds readers once per user and environment, whatever the group's size",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      // One chat each, because a chat caps its own active watches. Same user and
      // environment throughout: that is the pair the sweep must only resolve once.
      for (let index = 0; index < 6; index++) {
        await createChat(ctx.agentDb, {
          id: `chat_incident_${index}`,
          organizationId: ORGANIZATION_ID,
          userId: USER_ID,
        });
        await seedOverdueWatch({
          chatId: `chat_incident_${index}`,
          identity: `queue_stalled:queue_${index}`,
          spec: { ...STALLED, queue: `task/queue_${index}` },
        });
      }

      let authorizations = 0;
      let readerBuilds = 0;
      let inFlight = 0;
      let peakInFlight = 0;

      const result = await sweepDashboardAgentWatches({
        concurrency: 3,
        authorize: async () => {
          authorizations++;
          return { ok: true, environment } as const;
        },
        checkDeps: () => {
          readerBuilds++;
          return {
            ...checkDepsWithDepth(7),
            readQueueDepth: async () => {
              inFlight++;
              peakInFlight = Math.max(peakInFlight, inFlight);
              await new Promise((resolve) => setTimeout(resolve, 20));
              inFlight--;
              return { depth: 7, source: "live_queue", current: true };
            },
          };
        },
        deliver: async () => {},
        configured: () => true,
      });

      expect(result).toMatchObject({ overdue: 6, expired: 6, fired: 0, failed: 0 });
      // One authorization and one set of readers for the whole group.
      expect(authorizations).toBe(1);
      expect(readerBuilds).toBe(1);
      // Bounded, so one slow tenant can't hold the visibility window open.
      expect(peakInFlight).toBeGreaterThan(1);
      expect(peakInFlight).toBeLessThanOrEqual(3);
    }
  );

  postgresTest(
    "authorizes each initiating user separately",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      for (const suffix of ["a", "b"]) {
        await createChat(ctx.agentDb, {
          id: `chat_${suffix}`,
          organizationId: ORGANIZATION_ID,
          userId: `user_${suffix}`,
        });
        await seedOverdueWatch({
          chatId: `chat_${suffix}`,
          userId: `user_${suffix}`,
          identity: `queue_stalled:queue_${suffix}`,
        });
      }

      const authorized: string[] = [];
      await sweepDashboardAgentWatches({
        authorize: async (watch: Watch) => {
          authorized.push(watch.userId);
          return { ok: true, environment } as const;
        },
        checkDeps: () => checkDepsWithDepth(7),
        deliver: async () => {},
        configured: () => true,
      });

      expect([...authorized].sort()).toEqual(["user_a", "user_b"]);
    }
  );
});
