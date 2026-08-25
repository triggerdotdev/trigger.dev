import {
  armWatchBatch,
  createChat,
  createDashboardAgentDb,
  createWatch,
  getWatch,
  listActiveWatchesForBatch,
  recordWatchCheck,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps } from "~/services/dashboardAgentWatchChecks";

// What a batch tick records. A check that read nothing is not an observation: recording it
// would move the watch down the rotation and overwrite the facts a streak lives in.

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

process.env.SESSION_SECRET = "test-session-secret-for-watch-batch";

const { isDue, runWatchBatchCheck } = await import("~/services/dashboardAgentWatchBatch.server");
const { previousCheckFacts } = await import("~/services/dashboardAgentWatchChecks");

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

const ORGANIZATION_ID = "org_batch";
const PROJECT_ID = "proj_batch";
const ENVIRONMENT_ID = "env_batch_recording";
const USER_ID = "user_batch";
const CADENCE = 5;

const environment = {
  id: ENVIRONMENT_ID,
  organizationId: ORGANIZATION_ID,
  projectId: PROJECT_ID,
  slug: "prod",
  type: "PRODUCTION",
  project: { id: PROJECT_ID, externalRef: "proj_external" },
  organization: { id: ORGANIZATION_ID, slug: "batch" },
} as any;

const STALLED: WatchSpec = {
  kind: "queue_stalled",
  queue: "task/send-receipt",
  ticks: 3,
  checkEveryMinutes: CADENCE,
  maxHours: 6,
  note: "tell me if the queue stops moving",
};

/** A watch with two no-progress checks already behind it, last looked at `checkedAt`. */
async function seedStalling(checkedAt: Date): Promise<string> {
  await createChat(ctx.agentDb, {
    id: "chat_batch",
    organizationId: ORGANIZATION_ID,
    userId: USER_ID,
  });
  const created = await createWatch(ctx.agentDb, {
    chatId: "chat_batch",
    identity: "queue_stalled:task/send-receipt",
    spec: STALLED as any,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    userId: USER_ID,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
  });
  if (!created.ok) throw new Error(`the watch wasn't created: ${created.error}`);

  await recordWatchCheck(ctx.agentDb, {
    id: created.watch.id,
    lastCheckedAt: checkedAt,
    lastResult: {
      result: "pending",
      facts: {
        queue: "task/send-receipt",
        depth: 412,
        notDecreasingStreak: 2,
        ticks: STALLED.kind === "queue_stalled" ? STALLED.ticks : 3,
      },
    },
  });
  return created.watch.id;
}

function readers(overrides: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => ({ depth: 412, source: "live_queue", current: true }),
    readQueueOldestAge: async () => null,
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
    ...overrides,
  };
}

/** The chain this group's ticks run under. Armed once, like a live chain's. */
async function armChain(): Promise<number> {
  const armed = await armWatchBatch(ctx.agentDb, {
    environmentId: ENVIRONMENT_ID,
    cadenceMinutes: CADENCE,
    staleBefore: new Date(),
  });
  if (!armed) throw new Error("the batch chain wasn't armed");
  return armed.epoch;
}

/** A second watch in the same group, on its own queue so one reader can fail alone. */
async function seedSecondQueue(queue: string): Promise<string> {
  const created = await createWatch(ctx.agentDb, {
    chatId: "chat_batch",
    identity: `queue_stalled:${queue}`,
    spec: { ...STALLED, queue } as any,
    organizationId: ORGANIZATION_ID,
    projectId: PROJECT_ID,
    environmentId: ENVIRONMENT_ID,
    userId: USER_ID,
    expiresAt: new Date(Date.now() + 6 * 60 * 60 * 1000),
  });
  if (!created.ok) throw new Error(`the watch wasn't created: ${created.error}`);
  return created.watch.id;
}

async function tick(params: {
  epoch: number;
  tick: number;
  checkDeps: WatchCheckDeps;
  /** The group's per-tick cap, so an over-cap group can be exercised. */
  limit?: number;
}) {
  return runWatchBatchCheck(
    {
      environmentId: ENVIRONMENT_ID,
      cadenceMinutes: CADENCE,
      epoch: params.epoch,
      tick: params.tick,
    },
    {
      checkDeps: () => params.checkDeps,
      authorize: async () => ({ ok: true, environment }) as const,
      mintToken: async () => "watch_token",
      ...(params.limit
        ? {
            listActive: (args: { environmentId: string; cadenceMinutes: number }) =>
              listActiveWatchesForBatch(ctx.agentDb, { ...args, limit: params.limit }),
          }
        : {}),
    }
  );
}

describe("what a batch tick records", () => {
  postgresTest(
    "a check that couldn't read anything leaves the row's last look and facts alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const checkedAt = new Date(Date.now() - 60 * 60 * 1000);
      const watchId = await seedStalling(checkedAt);
      const epoch = await armChain();

      const response = await tick({
        epoch,
        tick: 1,
        checkDeps: readers({
          readQueueDepth: async () => {
            throw new Error("the queue reader is down");
          },
        }),
      });

      expect(response.watches?.[0]).toMatchObject({ watchId, result: "unavailable" });

      const row = await getWatch(ctx.agentDb, { id: watchId });
      // Nothing was checked, so the watch is still due at the next tick.
      expect(row?.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
      // And the streak the ticks built is still there to be continued.
      expect(previousCheckFacts(row?.lastResult)).toMatchObject({
        depth: 412,
        notDecreasingStreak: 2,
      });
    },
    30_000
  );

  postgresTest(
    "the next readable check continues the frozen streak and fires the stall",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const checkedAt = new Date(Date.now() - 60 * 60 * 1000);
      const watchId = await seedStalling(checkedAt);
      const epoch = await armChain();

      await tick({
        epoch,
        tick: 1,
        checkDeps: readers({
          readQueueDepth: async () => {
            throw new Error("the queue reader is down");
          },
        }),
      });
      const response = await tick({ epoch, tick: 2, checkDeps: readers() });

      expect(response.watches?.[0]).toMatchObject({ watchId, result: "satisfied" });

      const row = await getWatch(ctx.agentDb, { id: watchId });
      // A real evaluation does move the row's last look on.
      expect(row?.lastCheckedAt?.getTime()).toBeGreaterThan(checkedAt.getTime());
      expect(previousCheckFacts(row?.lastResult)).toMatchObject({ notDecreasingStreak: 3 });
    },
    30_000
  );

  postgresTest(
    "a permanently unreadable watch rotates out of an over-cap group's head",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const checkedAt = new Date(Date.now() - 60 * 60 * 1000);
      // Looked at an hour ago, so it leads the group; its reader never comes back.
      const broken = await seedStalling(checkedAt);
      const neighbour = await seedSecondQueue("task/send-invoice");
      const epoch = await armChain();

      const brokenQueue = STALLED.kind === "queue_stalled" ? STALLED.queue : "";
      const oneReaderDown = readers({
        readQueueDepth: async (queue: string) => {
          if (queue === brokenQueue) throw new Error("the queue reader is down");
          return { depth: 412, source: "live_queue", current: true };
        },
      });

      // A cap of one: whatever leads the group is the only watch the tick reaches.
      const first = await tick({ epoch, tick: 1, checkDeps: oneReaderDown, limit: 1 });
      expect(first.watches?.map((entry) => entry.watchId)).toEqual([broken]);
      expect(first.watches?.[0]).toMatchObject({ result: "unavailable" });

      // The neighbour is no longer crowded out by a watch that never reads anything.
      const second = await tick({ epoch, tick: 2, checkDeps: oneReaderDown, limit: 1 });
      expect(second.watches?.map((entry) => entry.watchId)).toEqual([neighbour]);
      expect(second.watches?.[0]).toMatchObject({ result: "pending" });

      // And nothing about the unreadable watch's own state moved: not its last check, not
      // the streak the earlier ticks built, and not its dueness.
      const row = await getWatch(ctx.agentDb, { id: broken });
      expect(row?.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
      expect(previousCheckFacts(row?.lastResult)).toMatchObject({
        depth: 412,
        notDecreasingStreak: 2,
      });
      expect(isDue(row!, CADENCE, new Date())).toBe(true);
    },
    30_000
  );
});
