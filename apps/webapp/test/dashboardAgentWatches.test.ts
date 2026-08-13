import {
  appendChatMessageOnce,
  armWatchBatch,
  cancelWatch,
  chatExists,
  claimWatchBatchTick,
  claimWatchDelivery,
  claimWatchTick,
  getWatchSubmission,
  listActiveWatchesForBatch,
  listWatchBatchGroupsToArm,
  stopWatchBatch,
  countUnreadWatchWakes,
  countUserMessages,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getWatch,
  listActiveWatchesForChat,
  listChatIdsWithUnreadWakes,
  listRecentWatchWakes,
  markWatchDelivered,
  readWatchWakeFeed,
  recordWatchCheck,
  recordWatchSubmissionOutcome,
  releaseWatchDelivery,
  transitionWatchCondition,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  type Watch,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchDraft, WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  previousCheckFacts,
  type WatchCheckDeps,
  type WatchRunRow,
} from "~/services/dashboardAgentWatchChecks";

// Every test here boots a container and replays the migrations inside its own budget,
// which does not fit vitest's 5s default on a loaded CI host.
vi.setConfig({ testTimeout: 60_000 });

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  canAccess: true,
  actor: undefined as undefined | { userId: string; client?: string; environmentId?: string },
  /** Every task id the suite would have triggered for real. */
  triggered: [] as string[],
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
  canAccessDashboardAgent: async () => ctx.canAccess,
}));

// The routes drive the real service, which builds a TriggerClient from .env — so an unmocked
// suite triggers actual runs against whatever origin .env names.
vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    TriggerClient: class {
      tasks = {
        trigger: async (taskId: string) => {
          ctx.triggered.push(taskId);
          return { id: "run_test" };
        },
      };
    },
  };
});

const SESSION_SECRET = "test-session-secret-for-watch-tokens";
process.env.SESSION_SECRET = SESSION_SECRET;
// The agent's subscribe endpoint refuses without an email transport configured.
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";
// Arming a batch chain builds a (stubbed) client only when this is set; unset in CI, it would
// no-op and the check test's trigger assertion would never see the batch task.
process.env.DASHBOARD_AGENT_SECRET_KEY = "test-dashboard-agent-secret";

const {
  armDashboardAgentWatchBatch,
  authorizeWatchEnvironment,
  cancelDashboardAgentWatch,
  createDashboardAgentWatch,
  deleteChatWithWatches,
  listActiveWatchesForChats,
  submitDashboardAgentWatch,
  watchBatchStaleMs,
} = await import("~/services/dashboardAgentWatches.server");
const { action: checkAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.$watchId.check");
const { action: createAction } = await import("~/routes/api.v1.dashboard-agent.watches");
const { action: batchCheckAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.batch-check");
const {
  rearmDashboardAgentWatchBatches,
  sweepDashboardAgentWatches,
  WATCH_DELIVERY_GRACE_MS,
  WATCH_EXPIRY_GRACE_MS,
} = await import("~/services/dashboardAgentWatchSweep.server");
const { runWatchBatchCheck } = await import("~/services/dashboardAgentWatchBatch.server");
const { signDashboardAgentWatchBatchToken, signDashboardAgentWatchToken } =
  await import("~/services/dashboardAgentWatchToken.server");
const { loader: alertsLoader, action: alertsAction } =
  await import("~/routes/api.v1.dashboard-agent.alerts");
const { action: alertChannelAction } =
  await import("~/routes/api.v1.dashboard-agent.alerts.$channelId");
const { findProjectBySlug } = await import("~/models/project.server");
const { DASHBOARD_AGENT_WATCH_ALERT_TYPE, subscribeUserToWatchAlerts } =
  await import("~/services/dashboardAgentWatchAlerts.server");

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  // A pool, not a single connection: the concurrent-create test needs the advisory lock to span connections.
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 8 });
  ctx.agentDb = agentDbClient.db;
}

async function seed(prisma: PrismaClient, slugBase: string) {
  const slug = `${slugBase}_${Math.random().toString(36).slice(2, 10)}`;
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
      shortcode: `p${slug.slice(0, 6)}`,
    },
  });
  return { user, organization, project, environment };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function authenticated(seeded: Seeded) {
  return {
    id: seeded.environment.id,
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    slug: "prod",
    type: "PRODUCTION",
    project: { id: seeded.project.id, externalRef: seeded.project.externalRef },
    organization: { id: seeded.organization.id, slug: seeded.organization.slug },
  } as any;
}

async function seedChat(seeded: Seeded, chatId = "chat_1") {
  await createChat(ctx.agentDb, {
    id: chatId,
    organizationId: seeded.organization.id,
    userId: seeded.user.id,
  });
  return chatId;
}

function runRow(overrides: Partial<WatchRunRow> = {}): WatchRunRow {
  return {
    friendlyId: "run_1",
    status: "PENDING",
    queue: "task/my-task",
    createdAt: new Date(),
    queuedAt: null,
    startedAt: null,
    completedAt: null,
    delayUntil: null,
    ...overrides,
  };
}

/** Injected readers. Defaults keep every condition pending with a live target. */
function fakeCheckDeps(overrides: Partial<WatchCheckDeps> = {}): WatchCheckDeps {
  return {
    readRun: async () => runRow(),
    queueExists: async () => true,
    readQueueDepth: async () => ({ depth: 7, source: "live_queue", current: true }),
    readQueueOldestAge: async () => ({ ageMs: 30_000, source: "live_queue", current: true }),
    readErrorRecurrence: async () => null,
    readHealth: async () => ({ trustworthy: true, severity: "warn" }),
    ...overrides,
  };
}

const RUN_START: WatchSpec = {
  kind: "run_start",
  runId: "run_1",
  checkEveryMinutes: 1,
  maxHours: 2,
  note: "tell me when it starts",
};

const BACKLOG: WatchSpec = {
  kind: "backlog_drain",
  queue: "task/my-task",
  checkEveryMinutes: 5,
  maxHours: 2,
  note: "tell me when it drains",
};

/** A run that exists for target validation and is gone when the immediate check reads it. */
function readRunOnce(first: WatchRunRow) {
  let calls = 0;
  return async () => (calls++ === 0 ? first : null);
}

function create(args: {
  seeded: Seeded;
  spec?: WatchSpec;
  chatId?: string;
  environmentId?: string;
  investigateOnAttention?: boolean;
  watchId?: string;
  checkDeps?: Partial<WatchCheckDeps>;
  scheduled?: Array<{ watchId: string; token: string; tick: number }>;
  onSchedule?: () => void;
}) {
  const environment = authenticated(args.seeded);
  return createDashboardAgentWatch({
    environment: args.environmentId ? { ...environment, id: args.environmentId } : environment,
    userId: args.seeded.user.id,
    chatId: args.chatId ?? "chat_1",
    spec: args.spec ?? RUN_START,
    investigateOnAttention: args.investigateOnAttention,
    watchId: args.watchId,
    deps: {
      configured: () => true,
      checkDeps: () => fakeCheckDeps(args.checkDeps),
      scheduleTick: async (params) => {
        args.onSchedule?.();
        args.scheduled?.push({
          watchId: params.watchId,
          token: params.token,
          tick: params.tick,
        });
      },
    },
  });
}

beforeEach(() => {
  ctx.canAccess = true;
  ctx.actor = undefined;
});

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("createDashboardAgentWatch", () => {
  postgresTest(
    "creates an active watch and schedules its first tick",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const scheduled: Array<{ watchId: string; token: string; tick: number }> = [];
      const result = await create({ seeded, scheduled });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe("active");
      expect(result.identity).toBe("run_start:run_1");
      expect(result.immediate).toBeUndefined();

      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.watchId).toBe(result.watchId);
      expect(scheduled[0]!.tick).toBe(1);
      expect(scheduled[0]!.token.startsWith("tr_daw_")).toBe(true);

      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      expect(row).toMatchObject({
        status: "active",
        deliveryStatus: "not_required",
        environmentId: seeded.environment.id,
        projectId: seeded.project.id,
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        tickCount: 0,
        investigateOnAttention: false,
        projectRef: seeded.project.externalRef,
      });
    }
  );

  postgresTest(
    "records the investigate-on-attention consent when the caller asks for it",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({ seeded, investigateOnAttention: true });

      expect(result.ok).toBe(true);
      if (!result.ok || !result.watching) return;
      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      expect(row?.investigateOnAttention).toBe(true);
      expect(result.identity).toBe("run_start:run_1");
    }
  );

  postgresTest(
    "stamps a server-set `since` on an error_recurrence watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const before = Date.now();
      const result = await create({
        seeded,
        spec: {
          kind: "error_recurrence",
          fingerprint: "fp_1",
          checkEveryMinutes: 5,
          maxHours: 2,
          note: "tell me if it comes back",
        },
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      const since = (row?.spec as { since?: string } | undefined)?.since;
      expect(since).toBeDefined();
      expect(new Date(since!).getTime()).toBeGreaterThanOrEqual(before - 1000);
    }
  );

  postgresTest(
    "answers with a one-shot result and writes no row when the condition already holds",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      let ticks = 0;
      const result = await create({
        seeded,
        checkDeps: {
          readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }),
        },
        onSchedule: () => {
          ticks += 1;
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.watching) throw new Error("expected a one-shot result");
      expect(result.immediate.result).toBe("satisfied");
      expect(result.immediate.observed).toMatchObject({ kind: "run_start", started: true });
      expect(ticks).toBe(0);

      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
      expect(
        await listActiveWatchesForChats({
          chatIds: ["chat_1"],
          organizationId: seeded.organization.id,
          userId: seeded.user.id,
        })
      ).toEqual({});
    }
  );

  postgresTest(
    "answers with a one-shot result when the condition can no longer happen",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        checkDeps: { readRun: readRunOnce(runRow({ status: "QUEUED" })) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.watching) throw new Error("expected a one-shot result");
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses a duplicate before running the immediate check",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const first = await create({ seeded });
      expect(first.ok).toBe(true);

      let checks = 0;
      const second = await create({
        seeded,
        checkDeps: {
          readRun: async () => {
            checks += 1;
            return runRow({ status: "EXECUTING", startedAt: new Date() });
          },
        },
      });

      expect(second).toMatchObject({ ok: false, code: "duplicate" });
      expect(checks).toBe(1);
    }
  );

  postgresTest(
    "cancels the row silently when the first tick can't be scheduled",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        onSchedule: () => {
          throw new Error("no agent project");
        },
      });

      expect(result).toMatchObject({ ok: false, code: "internal" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
      const rows = await ctx.prisma.$queryRawUnsafe<
        { status: string; cancel_reason: string; delivery_status: string }[]
      >(
        `select status, cancel_reason, delivery_status
         from trigger_dashboard_agent.watches where chat_id = 'chat_1'`
      );
      expect(rows).toMatchObject([
        {
          status: "cancelled",
          cancel_reason: "scheduling_failed",
          delivery_status: "not_required",
        },
      ]);
    }
  );

  postgresTest(
    "rejects a target that doesn't exist, writing nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: BACKLOG,
        checkDeps: { queueExists: async () => false },
      });

      expect(result).toMatchObject({ ok: false, code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "dedups the same condition and allows it in another environment",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      const first = await create({ seeded });
      expect(first.ok).toBe(true);

      const second = await create({ seeded });
      expect(second).toMatchObject({ ok: false, code: "duplicate" });
      if (!second.ok && first.ok) expect(second.existingId).toBe(first.watchId);

      const otherEnv = await prisma.runtimeEnvironment.create({
        data: {
          slug: "stg",
          type: "STAGING",
          projectId: seeded.project.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_stg_${seeded.project.slug}`,
          pkApiKey: `pk_stg_${seeded.project.slug}`,
          shortcode: `s${seeded.project.slug.slice(0, 6)}`,
        },
      });
      const third = await create({ seeded, environmentId: otherEnv.id });
      expect(third.ok).toBe(true);
    }
  );

  postgresTest(
    "refuses a 4th active watch in the same chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "watch");
      await seedChat(seeded);

      for (const runId of ["run_1", "run_2", "run_3"]) {
        const created = await create({ seeded, spec: { ...RUN_START, runId } });
        expect(created.ok).toBe(true);
      }

      const fourth = await create({ seeded, spec: { ...RUN_START, runId: "run_4" } });
      expect(fourth).toMatchObject({ ok: false, code: "limit_reached" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(3);
    }
  );

  postgresTest(
    "holds the ≤3 limit against four concurrent creates",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "race");
      await seedChat(seeded);

      const results = await Promise.all(
        ["run_1", "run_2", "run_3", "run_4"].map((runId) =>
          create({ seeded, spec: { ...RUN_START, runId } })
        )
      );

      expect(results.filter((result) => result.ok)).toHaveLength(3);
      expect(
        results.filter((result) => !result.ok && result.code === "limit_reached")
      ).toHaveLength(1);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(3);
    }
  );
});

describe("the createWatch endpoint's authorization", () => {
  function post(body: unknown) {
    return createAction({
      request: new Request("https://example.com/api/v1/dashboard-agent/watches", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {},
    });
  }

  const validBody = (chatId: string) => ({ spec: RUN_START, chatId });

  postgresTest("401s without a delegated token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const response = await post(validBody("chat_1"));
    expect(response.status).toBe(401);
  });

  postgresTest("403s for any other client's token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "adapter");
    ctx.actor = { userId: seeded.user.id, client: "cli", environmentId: seeded.environment.id };

    const response = await post(validBody("chat_1"));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "forbidden_client" });
  });

  postgresTest(
    "refuses a chat the authenticated user doesn't own, writing nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const owner = await seed(prisma, "owner");
      const stranger = await seed(prisma, "stranger");
      await createChat(ctx.agentDb, {
        id: "chat_victim",
        organizationId: owner.organization.id,
        userId: owner.user.id,
      });

      ctx.actor = {
        userId: stranger.user.id,
        client: "dashboard-agent",
        environmentId: stranger.environment.id,
      };

      const response = await post(validBody("chat_victim"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "chat_not_found" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_victim" })).toHaveLength(
        0
      );
    }
  );

  postgresTest(
    "refuses a token with no environment scope",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "noscope");
      await seedChat(seeded, "chat_1");
      ctx.actor = { userId: seeded.user.id, client: "dashboard-agent" };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses a body naming a different environment than the token's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "mismatch");
      const other = await seed(prisma, "othermismatch");
      await seedChat(seeded, "chat_1");
      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const response = await post({
        ...validBody("chat_1"),
        environmentId: other.environment.id,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "environment_mismatch" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "binds to the token's environment, not the chat's stored context",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "binding");
      const otherProject = await prisma.project.create({
        data: {
          name: `${seeded.project.slug}_b`,
          slug: `${seeded.project.slug}_b`,
          organizationId: seeded.organization.id,
          externalRef: `proj_${seeded.project.slug}_b`,
        },
      });
      const otherEnvironment = await prisma.runtimeEnvironment.create({
        data: {
          slug: "prod",
          type: "PRODUCTION",
          projectId: otherProject.id,
          organizationId: seeded.organization.id,
          apiKey: `tr_prod_${otherProject.slug}`,
          pkApiKey: `pk_prod_${otherProject.slug}`,
          shortcode: `b${otherProject.slug.slice(0, 6)}`,
        },
      });

      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        metadata: {
          context: {
            environmentId: seeded.environment.id,
            projectRef: seeded.project.externalRef,
          },
        },
      });
      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: otherEnvironment.id,
      };

      const response = await post({
        ...validBody("chat_1"),
        projectRef: seeded.project.externalRef,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "environment_mismatch" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "refuses an environment in another org than the chat's",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "crossorg");
      const other = await seed(prisma, "otherorg");
      await prisma.orgMember.create({
        data: {
          organizationId: other.organization.id,
          userId: seeded.user.id,
          role: "ADMIN",
        },
      });
      await seedChat(seeded, "chat_1");

      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: other.environment.id,
      };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );
});

describe("the chat cascade and the list view", () => {
  postgresTest(
    "deleting a chat soft-deletes it and cancels its active watches in one call",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "cascade");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const mine = await create({ seeded, chatId: "chat_1" });
      const theirs = await create({ seeded, chatId: "chat_2" });
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) return;

      expect(
        await deleteChatWithWatches({
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toEqual({
        deleted: true,
        cancelledWatches: 1,
      });

      expect(
        await chatExists(ctx.agentDb, {
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toBe(false);
      expect(await getWatch(ctx.agentDb, { id: mine.watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "chat_deleted",
        deliveryStatus: "not_required",
      });
      expect(await getWatch(ctx.agentDb, { id: theirs.watchId })).toMatchObject({
        status: "active",
      });
    }
  );

  postgresTest(
    "a user's own cancel leaves one neutral line in the chat, and only one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "usercancel");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const cancel = () =>
        cancelDashboardAgentWatch({
          watchId: created.watchId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        });

      expect(await cancel()).toMatchObject({
        cancelled: true,
        messages: [
          {
            id: `watch-cancelled:${created.watchId}`,
            role: "assistant",
            parts: [{ type: "text", text: "Stopped watching run run_1." }],
          },
        ],
      });
      expect(await getWatch(ctx.agentDb, { id: created.watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "user",
        deliveryStatus: "not_required",
      });
      expect(await storedMessages(seeded, "chat_1")).toMatchObject([
        { id: `watch-cancelled:${created.watchId}`, role: "assistant" },
      ]);

      // The row is no longer active, so the second cancel writes nothing at all.
      expect(await cancel()).toEqual({ cancelled: false, messages: [] });
      expect(await storedMessages(seeded, "chat_1")).toHaveLength(1);
    }
  );

  postgresTest(
    "a chat delete cancels its watches without a line in the chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "silentcancel");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);

      await deleteChatWithWatches({
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });

      const rows = await ctx.prisma.$queryRawUnsafe<{ message_id: string }[]>(
        `select message_id from trigger_dashboard_agent.chat_messages where chat_id = 'chat_1'`
      );
      expect(rows).toEqual([]);
    }
  );

  postgresTest(
    "aggregates active watches per chat in one query",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "chips");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const a = await create({ seeded, chatId: "chat_1", spec: { ...RUN_START, runId: "run_1" } });
      const b = await create({ seeded, chatId: "chat_1", spec: { ...RUN_START, runId: "run_2" } });
      const c = await create({ seeded, chatId: "chat_2" });
      expect(a.ok && b.ok && c.ok).toBe(true);

      const byChat = await listActiveWatchesForChats({
        chatIds: ["chat_1", "chat_2", "chat_missing"],
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });
      expect(byChat.chat_1).toHaveLength(2);
      expect(byChat.chat_2).toHaveLength(1);
      expect(byChat.chat_missing).toBeUndefined();
      expect(byChat.chat_2![0]).toMatchObject({
        identity: "run_start:run_1",
        status: "active",
        kind: "run_start",
        note: RUN_START.note,
      });

      if (a.ok) await cancelWatch(ctx.agentDb, { id: a.watchId, reason: "user" });
      if (b.ok) await cancelWatch(ctx.agentDb, { id: b.watchId, reason: "user" });
      expect(
        (
          await listActiveWatchesForChats({
            chatIds: ["chat_1"],
            organizationId: seeded.organization.id,
            userId: seeded.user.id,
          })
        ).chat_1
      ).toBeUndefined();
    }
  );

  postgresTest("returns nothing for an empty chat list", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    expect(
      await listActiveWatchesForChats({ chatIds: [], organizationId: "org_x", userId: "user_x" })
    ).toEqual({});
  });
});

describe("unread watch wakes", () => {
  postgresTest(
    "only signals a wake once its delivery landed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "unread");
      await seedChat(seeded, "chat_1");

      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const scope = { organizationId: seeded.organization.id, userId: seeded.user.id };
      const recent = { ...scope, deliveredAfter: new Date(Date.now() - 15 * 60 * 1000) };

      if (!created.watching) throw new Error("expected a watch");
      await transitionWatchCondition(ctx.agentDb, {
        id: created.watchId,
        resolution: "condition_met",
      });
      expect(await countUnreadWatchWakes(ctx.agentDb, scope)).toBe(0);
      expect(await listRecentWatchWakes(ctx.agentDb, recent)).toEqual([]);
      expect(await listChatIdsWithUnreadWakes(ctx.agentDb, scope)).toEqual(new Set());

      await markWatchDelivered(ctx.agentDb, { id: created.watchId });
      expect(await countUnreadWatchWakes(ctx.agentDb, scope)).toBe(1);
      expect(await listRecentWatchWakes(ctx.agentDb, recent)).toMatchObject([
        { watchId: created.watchId, chatId: "chat_1", outcome: "fired", unread: true },
      ]);
      expect(await listChatIdsWithUnreadWakes(ctx.agentDb, scope)).toEqual(new Set(["chat_1"]));

      // The poll's single query answers both halves the same way.
      expect(await readWatchWakeFeed(ctx.agentDb, recent)).toMatchObject({
        unreadWakes: 1,
        wakes: [{ watchId: created.watchId, chatId: "chat_1", outcome: "fired", unread: true }],
      });

      // An unread wake from before the window still counts, but isn't narrated again.
      expect(
        await readWatchWakeFeed(ctx.agentDb, {
          ...scope,
          deliveredAfter: new Date(Date.now() + 60_000),
        })
      ).toMatchObject({ unreadWakes: 1, wakes: [] });
    }
  );
});

describe("authorizeWatchEnvironment", () => {
  postgresTest(
    "passes for a member and fails once membership is gone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "auth");

      const params = {
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
      };

      expect((await authorizeWatchEnvironment(params)).ok).toBe(true);

      await prisma.orgMember.deleteMany({ where: { userId: seeded.user.id } });
      expect(await authorizeWatchEnvironment(params)).toEqual({
        ok: false,
        reason: "access_revoked",
      });
    }
  );

  postgresTest("fails when the feature gate is revoked", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "auth");
    ctx.canAccess = false;

    expect(
      await authorizeWatchEnvironment({
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        projectId: seeded.project.id,
        environmentId: seeded.environment.id,
      })
    ).toEqual({ ok: false, reason: "access_revoked" });
  });

  postgresTest(
    "fails when the snapshot names a different project",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "auth");
      const other = await seed(prisma, "other");

      expect(
        await authorizeWatchEnvironment({
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
          projectId: other.project.id,
          environmentId: seeded.environment.id,
        })
      ).toEqual({ ok: false, reason: "access_revoked" });
    }
  );
});

describe("the watch sweep", () => {
  async function overdueWatch(seeded: Seeded, chatId = "chat_1") {
    const created = await create({ seeded, chatId });
    if (!created.ok) throw new Error("the watch wasn't created");
    await ctx.prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 hour' where id = $1`,
      created.watchId
    );
    return created.watchId;
  }

  function sweepDeps(args: {
    seeded: Seeded;
    checkDeps?: Partial<WatchCheckDeps>;
    revoked?: boolean;
    now?: Date;
    failDelivery?: boolean;
    delivered: string[];
  }) {
    return {
      now: () => args.now ?? new Date(),
      checkDeps: () => fakeCheckDeps(args.checkDeps),
      authorize: async () =>
        args.revoked
          ? ({ ok: false, reason: "access_revoked" } as const)
          : ({ ok: true, environment: authenticated(args.seeded) } as const),
      deliver: async (watch: Watch) => {
        if (args.failDelivery) throw new Error("the delivery couldn't be scheduled");
        args.delivered.push(watch.id);
      },
      configured: () => true,
    };
  }

  postgresTest(
    "runs the final check on an overdue watch and fires it at the buzzer",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(
        sweepDeps({
          seeded,
          delivered,
          checkDeps: {
            readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }),
          },
        })
      );

      expect(result).toMatchObject({ overdue: 1, fired: 1, expired: 0, cancelled: 0, failed: 0 });
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "fired",
        deliveryStatus: "pending",
      });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "expires an overdue watch the check says hasn't happened, as verified",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }));

      expect(result).toMatchObject({ overdue: 1, expired: 1, failed: 0 });
      const row = await getWatch(ctx.agentDb, { id: watchId });
      expect(row).toMatchObject({ status: "expired", deliveryStatus: "pending" });
      expect(row?.lastResult).toMatchObject({ verified: true, reason: "not_met_by_expiry" });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "cancels an overdue watch whose user lost access, and never wakes the chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(
        sweepDeps({ seeded, delivered, revoked: true })
      );

      expect(result).toMatchObject({ overdue: 1, cancelled: 1, expired: 0, fired: 0, failed: 0 });
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "cancelled",
        cancelReason: "access_revoked",
        deliveryStatus: "not_required",
      });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "leaves a watch that is still inside its deadline alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);

      const delivered: string[] = [];
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }));

      expect(result).toMatchObject({ overdue: 0, undelivered: 0 });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "recovers a wake the delivery lost, through the real query, exactly once",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      await expect(
        sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, failDelivery: true }))
      ).rejects.toThrow(/failed on 1 watches/);
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        deliveryStatus: "pending",
      });
      expect(delivered).toEqual([]);

      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const second = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));
      expect(second).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(delivered).toEqual([watchId]);

      await markWatchDelivered(ctx.agentDb, { id: watchId });
      const third = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));
      expect(third).toMatchObject({ undelivered: 0, redelivered: 0 });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "a deliverer that died mid-delivery is recovered, but a fresh claim is left alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }));

      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_status = 'delivering',
             delivery_claimed_at = now(),
             last_checked_at = now() - interval '1 hour'
         where id = $1`,
        watchId
      );
      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }))).toMatchObject({
        undelivered: 0,
      });

      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_claimed_at = now() - interval '1 hour' where id = $1`,
        watchId
      );
      const recovered: string[] = [];
      expect(
        await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: recovered }))
      ).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(recovered).toEqual([watchId]);
    }
  );

  postgresTest(
    "leaves nothing owed for a request the immediate check already answered",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);

      const created = await create({
        seeded,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });
      expect(created.ok).toBe(true);
      if (!created.ok || created.watching) throw new Error("expected a one-shot result");

      const delivered: string[] = [];
      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const result = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));

      expect(result).toMatchObject({ overdue: 0, undelivered: 0, redelivered: 0 });
      expect(delivered).toEqual([]);
    }
  );

  postgresTest(
    "finalizes overdue watches even with no agent to deliver to, and delivers once it's back",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      const delivered: string[] = [];
      const unconfigured = await sweepDashboardAgentWatches({
        ...sweepDeps({ seeded, delivered }),
        configured: () => false,
      });

      expect(unconfigured).toMatchObject({
        overdue: 1,
        expired: 1,
        deliveryDeferred: 1,
        undelivered: 0,
        redelivered: 0,
        failed: 0,
      });
      expect(delivered).toEqual([]);
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        deliveryStatus: "pending",
      });

      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const restored = await sweepDashboardAgentWatches(
        sweepDeps({ seeded, delivered, now: later })
      );
      expect(restored).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(delivered).toEqual([watchId]);
    }
  );

  postgresTest(
    "the expiry grace keeps the sweep off a watch the tick chain is still finishing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // A second past the deadline, so the chain's own final check owns this window.
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 second' where id = $1`,
        created.watchId
      );
      const delivered: string[] = [];
      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }))).toMatchObject({
        overdue: 0,
      });

      const later = new Date(Date.now() + WATCH_EXPIRY_GRACE_MS + 60_000);
      expect(
        await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }))
      ).toMatchObject({ overdue: 1, expired: 1 });
    }
  );
});

describe("the tick claim", () => {
  postgresTest(
    "claiming a generation is not an observation: only a recorded check stamps one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim");
      await seedChat(seeded);
      const created = await create({ seeded });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const claimed = await claimWatchTick(ctx.agentDb, { id: created.watchId, generation: 1 });
      expect(claimed).toMatchObject({ tickCount: 1, lastCheckedAt: null, lastResult: null });

      await recordWatchCheck(ctx.agentDb, { id: created.watchId, lastResult: { pending: 4 } });
      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(row?.lastCheckedAt).toBeInstanceOf(Date);
      expect(row?.lastResult).toMatchObject({ pending: 4 });
      expect(row?.tickCount).toBe(1);
    }
  );
});

// The delivery claim's fencing token: a hung deliverer is taken over, so an unfenced release or mark would touch the new owner's claim.
describe("the delivery claim", () => {
  async function firedWatch(seeded: Seeded) {
    const created = await create({ seeded });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error("the watch wasn't created");
    const transitioned = await transitionWatchCondition(ctx.agentDb, {
      id: created.watchId,
      status: "fired",
      lastResult: { result: "satisfied", facts: { verified: true } },
    });
    expect(transitioned).toMatchObject({ deliveryStatus: "pending" });
    return created.watchId;
  }

  function staleBefore() {
    return new Date(Date.now() - WATCH_DELIVERY_CLAIM_STALE_MS);
  }

  async function ageClaim(watchId: string) {
    await ctx.prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches
       set delivery_claimed_at = now() - interval '1 hour' where id = $1`,
      watchId
    );
  }

  postgresTest(
    "a stale takeover makes the old owner's release a no-op, and the new owner delivers once",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-fence");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      const a = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(a).not.toBeNull();
      if (!a) return;

      await ageClaim(watchId);
      const b = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(b).not.toBeNull();
      if (!b) return;
      expect(b.claimId).not.toBe(a.claimId);

      expect(
        await releaseWatchDelivery(ctx.agentDb, { id: watchId, claimId: a.claimId })
      ).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveryClaimId: b.claimId,
      });

      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();

      expect(
        await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })
      ).toMatchObject({ deliveryStatus: "delivered" });
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })).toBeNull();
    }
  );

  postgresTest(
    "a late delivered-mark from the old owner completes nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-late");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      const a = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(a).not.toBeNull();
      if (!a) return;
      await ageClaim(watchId);
      const b = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(b).not.toBeNull();
      if (!b) return;

      expect(await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: a.claimId })).toBeNull();
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveredAt: null,
      });

      expect(
        await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: b.claimId })
      ).toMatchObject({ deliveryStatus: "delivered" });
    }
  );

  postgresTest(
    "the inline path marks a pending delivery without a claim",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "claim-inline");
      await seedChat(seeded);
      const watchId = await firedWatch(seeded);

      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivered",
      });
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();
    }
  );
});

describe("deleting a chat while a watch is being created", () => {
  postgresTest("holds in both orders", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "race");

    for (const deleteFirst of [true, false]) {
      const chatId = `chat_${deleteFirst ? "del" : "add"}`;
      await seedChat(seeded, chatId);

      const creating = () => create({ seeded, chatId });
      const deleting = () =>
        deleteChatWithWatches({
          chatId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        });
      const [a, b] = deleteFirst
        ? await Promise.all([deleting(), creating()])
        : await Promise.all([creating(), deleting()]);
      expect(a).toBeDefined();
      expect(b).toBeDefined();

      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId })).toEqual([]);
      expect(
        await chatExists(ctx.agentDb, {
          chatId,
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
        })
      ).toBe(false);
    }
  });

  postgresTest(
    "refuses a create against an already-deleted chat",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "race");
      await seedChat(seeded);
      await deleteChatWithWatches({
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });

      expect(await create({ seeded })).toMatchObject({ ok: false, code: "chat_not_found" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );
});

describe("the check endpoint", () => {
  function request(token: string, body: unknown = {}) {
    return new Request("https://example.com/api/v1/dashboard-agent/watches/x/check", {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function activeWatch(seeded: Seeded, spec?: WatchSpec) {
    const result = await create({ seeded, spec });
    if (!result.ok) throw new Error(`watch not created: ${result.code}`);
    return result;
  }

  function tokenFor(watchId: string, expiresAt: Date) {
    return signDashboardAgentWatchToken(SESSION_SECRET, { watchId, expiresAt });
  }

  postgresTest("401s on a bad token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);

    const response = await checkAction({
      request: request("tr_daw_nonsense"),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(401);
  });

  postgresTest("403s when the token names another watch", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor("watch_someone_else", watch.expiresAt);

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "watch_mismatch" });
  });

  postgresTest("answers a check and records what it saw", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor(watch.watchId, watch.expiresAt);

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.result).toBe("terminal_unsatisfied");

    // Arming the chain goes through the stubbed client, never a real trigger.
    expect(ctx.triggered).toContain("dashboard-agent-watch-batch");

    const row = await getWatch(ctx.agentDb, { id: watch.watchId });
    expect(row?.lastCheckedAt).not.toBeNull();
    expect(row?.tickCount).toBe(0);
    expect(row?.status).toBe("active");
  });

  postgresTest(
    "refuses an ordinary check after expiry but allows the final one in grace",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);
      const watch = await activeWatch(seeded);

      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 minute' where id = $1`,
        watch.watchId
      );

      const token = await tokenFor(watch.watchId, watch.expiresAt);

      const refused = await checkAction({
        request: request(token, {}),
        params: { watchId: watch.watchId },
        context: {},
      });
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({ code: "expired" });

      const allowed = await checkAction({
        request: request(token, { final: true }),
        params: { watchId: watch.watchId },
        context: {},
      });
      expect(allowed.status).toBe(200);
    }
  );

  postgresTest(
    "cancels the watch on revoked access, without reading environment data",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);
      const watch = await activeWatch(seeded);
      const token = await tokenFor(watch.watchId, watch.expiresAt);

      await prisma.orgMember.deleteMany({ where: { userId: seeded.user.id } });

      const response = await checkAction({
        request: request(token),
        params: { watchId: watch.watchId },
        context: {},
      });

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "access_revoked" });

      const row = await getWatch(ctx.agentDb, { id: watch.watchId });
      expect(row).toMatchObject({
        status: "cancelled",
        cancelReason: "access_revoked",
        deliveryStatus: "not_required",
      });
      expect(row?.tickCount).toBe(0);
      expect(row?.lastResult).toBeNull();
    }
  );

  postgresTest(
    "a check that couldn't read anything leaves the row's last look and facts alone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);

      // The queue exists, so the check gets past the target read and fails on the depth
      // read: there is no live queue or analytics store behind this environment.
      const queue = "task/stalling";
      await prisma.taskQueue.create({
        data: {
          runtimeEnvironmentId: seeded.environment.id,
          projectId: seeded.project.id,
          name: queue,
          friendlyId: `queue_${Math.random().toString(36).slice(2, 10)}`,
          orderableName: queue,
        },
      });

      const watch = await activeWatch(seeded, {
        kind: "queue_stalled",
        queue,
        ticks: 3,
        checkEveryMinutes: 5,
        maxHours: 6,
        note: "tell me if the queue stops moving",
      });

      // Two no-progress checks already behind it, last looked at an hour ago.
      const checkedAt = new Date(Date.now() - 60 * 60 * 1000);
      await recordWatchCheck(ctx.agentDb, {
        id: watch.watchId,
        lastCheckedAt: checkedAt,
        lastResult: {
          result: "pending",
          facts: { queue, depth: 412, notDecreasingStreak: 2, ticks: 3 },
        },
      });

      const token = await tokenFor(watch.watchId, watch.expiresAt);
      const response = await checkAction({
        request: request(token),
        params: { watchId: watch.watchId },
        context: {},
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ result: "unavailable" });

      const row = await getWatch(ctx.agentDb, { id: watch.watchId });
      // Nothing was checked, so the watch is still due at the next tick.
      expect(row?.lastCheckedAt?.getTime()).toBe(checkedAt.getTime());
      // And the streak the earlier ticks built is still there to be continued.
      expect(previousCheckFacts(row?.lastResult)).toMatchObject({
        depth: 412,
        notDecreasingStreak: 2,
      });
    },
    120_000
  );

  postgresTest("403s once the watch is terminal", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "check");
    await seedChat(seeded);
    const watch = await activeWatch(seeded);
    const token = await tokenFor(watch.watchId, watch.expiresAt);

    await prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches set status = 'cancelled' where id = $1`,
      watch.watchId
    );

    const response = await checkAction({
      request: request(token),
      params: { watchId: watch.watchId },
      context: {},
    });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "cancelled" });
  });
});

/** A configured card, with both follow-ups off unless a test turns one on. */
function draftFor(spec: WatchSpec, followUp: Partial<WatchDraft["followUp"]> = {}): WatchDraft {
  return {
    spec,
    followUp: { investigateOnAttention: false, notifyExternally: false, ...followUp },
  };
}

function submit(args: {
  seeded: Seeded;
  draft?: WatchDraft;
  chatId?: string;
  clientRequestId?: string;
  checkDeps?: Partial<WatchCheckDeps>;
  subscribed?: boolean;
  /** Replaces the fake outright, so a test can hand the submit the real subscribe. */
  subscribe?: typeof subscribeUserToWatchAlerts;
  onSchedule?: () => void;
  /** Wraps the creation step, so a test can die at the exact point after it. */
  create?: typeof createDashboardAgentWatch;
}) {
  return submitDashboardAgentWatch({
    environment: authenticated(args.seeded),
    userId: args.seeded.user.id,
    organizationId: args.seeded.organization.id,
    chatId: args.chatId,
    clientRequestId: args.clientRequestId ?? "wreq_1",
    draft: args.draft ?? draftFor(RUN_START),
    deps: {
      configured: () => true,
      checkDeps: () => fakeCheckDeps(args.checkDeps),
      scheduleTick: async () => args.onSchedule?.(),
      ...(args.create ? { create: args.create } : {}),
      subscribe:
        args.subscribe ??
        (async () =>
          args.subscribed === false
            ? { ok: false, reason: "dashboard_agent_disabled" }
            : { ok: true, email: args.seeded.user.email }),
    },
  });
}

function storedMessages(seeded: Seeded, chatId: string) {
  return getChatMessages(ctx.agentDb, {
    chatId,
    userId: seeded.user.id,
    organizationId: seeded.organization.id,
  }) as Promise<Array<{ id: string; role: string }> | null>;
}

/**
 * The Alerts page authorizes with `findProjectBySlug` alone (see
 * `_app.orgs.$organizationSlug.projects.$projectParam.env.$envParam.alerts/route.tsx`):
 * every organization member may list, create and delete a project's alert channels, with
 * no role check. These tests pin that policy and prove the agent's routes never write
 * wider than it.
 */
describe("the agent's alert boundary", () => {
  /** A second, plain member of the same organization. */
  async function seedMember(prisma: PrismaClient, seeded: Seeded) {
    const member = await prisma.user.create({
      data: {
        email: `member_${Math.random().toString(36).slice(2, 10)}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: member.id, role: "MEMBER" },
    });
    return member;
  }

  async function seedOutsider(prisma: PrismaClient) {
    return prisma.user.create({
      data: {
        email: `outsider_${Math.random().toString(36).slice(2, 10)}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
  }

  async function seedWatchChannel(prisma: PrismaClient, seeded: Seeded, email: string) {
    return prisma.projectAlertChannel.create({
      data: {
        friendlyId: `alert_${Math.random().toString(36).slice(2, 10)}`,
        name: `Watch alerts for ${email}`,
        projectId: seeded.project.id,
        alertTypes: [DASHBOARD_AGENT_WATCH_ALERT_TYPE as never],
        environmentTypes: ["PRODUCTION"],
        type: "EMAIL",
        properties: { email },
        deduplicationKey: `dashboard-agent-watch:${email}`,
      },
    });
  }

  function listRequest(chatId: string) {
    return {
      request: new Request(
        `https://app.trigger.dev/api/v1/dashboard-agent/alerts?chatId=${chatId}`,
        { headers: { Authorization: "Bearer tr_uat_test" } }
      ),
      params: {},
      context: {} as never,
    } as never;
  }

  function createRequest(body: Record<string, unknown>) {
    return {
      request: new Request("https://app.trigger.dev/api/v1/dashboard-agent/alerts", {
        method: "POST",
        headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {} as never,
    } as never;
  }

  function deleteRequest(channelId: string, body: Record<string, unknown>) {
    return {
      request: new Request(`https://app.trigger.dev/api/v1/dashboard-agent/alerts/${channelId}`, {
        method: "DELETE",
        headers: { Authorization: "Bearer tr_uat_test", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: { channelId },
      context: {} as never,
    } as never;
  }

  postgresTest(
    "the dashboard lets any organization member manage a project's alerts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-policy");
      const member = await seedMember(prisma, seeded);
      const outsider = await seedOutsider(prisma);

      // The whole of the Alerts page's authorization, for list, create and delete alike.
      expect(
        await findProjectBySlug(seeded.organization.slug, seeded.project.slug, member.id)
      ).not.toBeNull();
      expect(
        await findProjectBySlug(seeded.organization.slug, seeded.project.slug, outsider.id)
      ).toBeNull();
    }
  );

  postgresTest(
    "a plain member reads and writes watch alerts through the agent, an outsider reads nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-member");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });
      await seedWatchChannel(prisma, seeded, member.email);

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const listed = (await alertsLoader(listRequest("chat_member"))) as Response;
      expect(listed.status).toBe(200);
      // The same channel the Alerts page would show this member.
      expect((await listed.json()).alerts).toHaveLength(1);

      // An outsider has no chat here and no membership, so nothing resolves.
      ctx.actor = {
        userId: (await seedOutsider(prisma)).id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const refused = (await alertsLoader(listRequest("chat_member"))) as Response;
      expect(refused.status).toBe(404);
    }
  );

  postgresTest(
    "the agent only ever subscribes the caller's own address",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-create");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const own = (await alertsAction(
        createRequest({ chatId: "chat_member", channel: "email" })
      )) as Response;
      expect(own.status).toBe(200);
      expect((await own.json()).target).toBe(member.email);

      // The Alerts page would let this member add anyone; the agent may not.
      const other = (await alertsAction(
        createRequest({
          chatId: "chat_member",
          channel: "email",
          email: "someone-else@example.com",
        })
      )) as Response;
      expect(other.status).toBe(400);
      expect(await other.json()).toMatchObject({ code: "email_not_allowed" });

      expect(
        await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
      ).toBe(1);
    }
  );

  postgresTest(
    "the agent's delete only takes the watch type off a watch channel",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "alert-delete");
      const member = await seedMember(prisma, seeded);
      await createChat(ctx.agentDb, {
        id: "chat_member",
        organizationId: seeded.organization.id,
        userId: member.id,
      });
      const watchChannel = await seedWatchChannel(prisma, seeded, member.email);

      // A channel the agent never created and has no business touching.
      const runAlerts = await prisma.projectAlertChannel.create({
        data: {
          friendlyId: `alert_${Math.random().toString(36).slice(2, 10)}`,
          name: "Run failures",
          projectId: seeded.project.id,
          alertTypes: ["TASK_RUN"],
          environmentTypes: ["PRODUCTION"],
          type: "EMAIL",
          properties: { email: member.email },
        },
      });

      ctx.actor = {
        userId: member.id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };

      const removed = (await alertChannelAction(
        deleteRequest(watchChannel.id, { chatId: "chat_member" })
      )) as Response;
      expect(removed.status).toBe(200);
      expect(await removed.json()).toMatchObject({ ok: true, disabledChannel: true });

      // The Alerts page would let a member delete this outright; the agent gets a 404.
      const untouched = (await alertChannelAction(
        deleteRequest(runAlerts.id, { chatId: "chat_member" })
      )) as Response;
      expect(untouched.status).toBe(404);
      expect(
        await prisma.projectAlertChannel.findFirst({ where: { id: runAlerts.id } })
      ).toMatchObject({ enabled: true, alertTypes: ["TASK_RUN"] });

      // An outsider can't reach the channel at all.
      ctx.actor = {
        userId: (await seedOutsider(prisma)).id,
        client: "dashboard-agent",
        environmentId: seeded.environment.id,
      };
      const refused = (await alertChannelAction(
        deleteRequest(watchChannel.id, { chatId: "chat_member" })
      )) as Response;
      expect(refused.status).toBe(404);
    }
  );
});

describe("the watch card submit", () => {
  postgresTest(
    "records what the user confirmed before the watch, and confirms it after",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit");
      await seedChat(seeded);

      const result = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor(RUN_START, { investigateOnAttention: true }),
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(true);
      expect(result.repaired).toBe(false);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${result.watchId}`,
      ]);
      // The consent record is the user's, and it states the condition and the lifetime.
      expect(stored?.[0]).toMatchObject({ role: "user" });
      expect(JSON.stringify(stored?.[0])).toContain("Watch run run_1 until it starts.");
      expect(JSON.stringify(stored?.[0])).toContain("Investigate straight away");
      expect(result.messages.map((message) => message.id)).toEqual(
        stored?.map((message) => message.id)
      );
    }
  );

  postgresTest(
    "leaves a repairable state when the confirmation never lands, and the retry repairs it",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-repair");
      await seedChat(seeded);

      // The crash state: the request record is written and the watch is live, but the
      // process died before the confirmation was appended.
      await appendChatMessageOnce(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        message: { id: "watch-request:wreq_1", role: "user", parts: [] } as never,
      });
      const created = await create({ seeded, chatId: "chat_1" });
      expect(created.ok).toBe(true);
      if (!created.ok || !created.watching) return;

      const retry = await submit({ seeded, chatId: "chat_1", clientRequestId: "wreq_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(created.watchId);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${created.watchId}`,
      ]);

      // Still exactly one watch: the repair loaded it rather than creating another.
      const active = await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" });
      expect(active).toHaveLength(1);
    }
  );

  postgresTest(
    "a retried submit duplicates neither record",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-retry");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      const second = await submit({ seeded, chatId: "chat_1" });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.repaired).toBe(true);
      expect(second.watchId).toBe(first.watchId);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a genuinely different request still conflicts",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-conflict");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // Same condition, so the same identity, but a different window: not a retry.
      const longer = await submit({
        seeded,
        chatId: "chat_1",
        clientRequestId: "wreq_2",
        draft: draftFor({ ...RUN_START, maxHours: 6 }),
      });
      expect(longer).toMatchObject({ ok: false, code: "duplicate", existingId: first.watchId });

      // Same spec, different consent: also not a retry.
      const investigating = await submit({
        seeded,
        chatId: "chat_1",
        clientRequestId: "wreq_3",
        draft: draftFor(RUN_START, { investigateOnAttention: true }),
      });
      expect(investigating).toMatchObject({ ok: false, code: "duplicate" });

      // The refused attempts are recorded under their own consent records, so the
      // transcript never shows a request with no answer.
      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
        "watch-request:wreq_2",
        "watch-confirmation:refused:wreq_2",
        "watch-request:wreq_3",
        "watch-confirmation:refused:wreq_3",
      ]);
    }
  );

  postgresTest(
    "a fresh panel's retry reuses the chat the first attempt created",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-fresh");

      const first = await submit({ seeded, clientRequestId: "wreq_fresh" });
      const second = await submit({ seeded, clientRequestId: "wreq_fresh" });

      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;
      expect(second.chatId).toBe(first.chatId);

      const stored = await storedMessages(seeded, first.chatId);
      expect(stored).toHaveLength(2);
    }
  );

  postgresTest(
    "an answered condition records the request and a one-shot result, and never a watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-oneshot");
      await seedChat(seeded);

      const result = await submit({
        seeded,
        chatId: "chat_1",
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      expect(result.watchId).toBeNull();

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        "watch-confirmation:one-shot:wreq_1",
      ]);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  /** Every watch row for a chat, terminal ones included. `listActiveWatchesForChat` can't see those. */
  async function countWatchRows(prisma: PrismaClient, chatId: string) {
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `select count(*)::bigint as count from trigger_dashboard_agent.watches where chat_id = $1`,
      chatId
    );
    return Number(rows[0]?.count ?? 0);
  }

  postgresTest(
    "a retry after the watch has already fired creates no second watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-fired");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok || !first.watchId) return;

      // The watch resolves and leaves the active set, so a duplicate check would find
      // nothing. Only the ledger still knows this request already ran.
      await transitionWatchCondition(ctx.agentDb, {
        id: first.watchId,
        resolution: "condition_met",
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(first.watchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a retry of an answered one-shot never becomes a watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-oneshot-retry");
      await seedChat(seeded);

      const first = await submit({
        seeded,
        chatId: "chat_1",
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING", startedAt: new Date() }) },
      });
      expect(first.ok && first.watching === false).toBe(true);

      // The world moved on: the same condition would now be pending, so a re-evaluation
      // would start a real watch. The recorded outcome is replayed instead.
      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.watching).toBe(false);
      expect(retry.watchId).toBeNull();
      expect(retry.repaired).toBe(true);
      expect(await countWatchRows(prisma, "chat_1")).toBe(0);

      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        "watch-confirmation:one-shot:wreq_1",
      ]);
    }
  );

  postgresTest(
    "the same request id carrying a different draft is a conflict",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-hash");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const changed = await submit({
        seeded,
        chatId: "chat_1",
        draft: draftFor({ ...RUN_START, maxHours: 6 }),
      });
      expect(changed).toMatchObject({ ok: false, code: "request_conflict" });

      // A conflict writes nothing at all: no watch, and no record under the request.
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);
      const stored = await storedMessages(seeded, "chat_1");
      expect(stored?.map((message) => message.id)).toEqual([
        "watch-request:wreq_1",
        `watch-confirmation:${first.watchId}`,
      ]);
    }
  );

  postgresTest(
    "a pending submission converges on the watch its first attempt created",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-converge");
      await seedChat(seeded);

      // The crash state the ledger exists for: the row is reserved, the watch is live
      // under the reserved id, and the process died before the outcome was written.
      let reservedWatchId = "";
      await expect(
        submit({
          seeded,
          chatId: "chat_1",
          create: async (createParams) => {
            reservedWatchId = createParams.watchId!;
            await createDashboardAgentWatch(createParams);
            throw new Error("died after the watch was created");
          },
        })
      ).rejects.toThrow("died after the watch was created");

      const pending = await getWatchSubmission(ctx.agentDb, {
        chatId: "chat_1",
        clientRequestId: "wreq_1",
      });
      expect(pending).toMatchObject({ state: "pending", watchId: reservedWatchId });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      // Reached the reserved row rather than creating another.
      expect(retry.watchId).toBe(reservedWatchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const settled = await getWatchSubmission(ctx.agentDb, {
        chatId: "chat_1",
        clientRequestId: "wreq_1",
      });
      expect(settled).toMatchObject({ state: "created", watchId: reservedWatchId });
    }
  );

  postgresTest(
    "converging on a watch that already fired confirms the outcome, not 'watching'",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-converge-fired");
      await seedChat(seeded);

      let reservedWatchId = "";
      await expect(
        submit({
          seeded,
          chatId: "chat_1",
          create: async (createParams) => {
            reservedWatchId = createParams.watchId!;
            await createDashboardAgentWatch(createParams);
            throw new Error("died after the watch was created");
          },
        })
      ).rejects.toThrow("died after the watch was created");

      // The watch ran and woke the chat before anyone retried the submit.
      await transitionWatchCondition(ctx.agentDb, {
        id: reservedWatchId,
        resolution: "condition_met",
        observedOutcome: { kind: "run_start", verified: true, status: "EXECUTING", started: true },
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      // Still one row, still the same watch: adoption is not refused.
      expect(retry.watchId).toBe(reservedWatchId);
      expect(await countWatchRows(prisma, "chat_1")).toBe(1);

      const parts = retry.messages.at(-1)?.parts ?? [];
      const block = (parts[0] as any).data.blocks[0];
      expect(block.outcome).toBe("already_true");
      expect(block.headline).not.toContain("Watching");
      expect(block.lifetime).toBeNull();
    }
  );

  postgresTest(
    "a refusal that wins the race leaves no live watch behind",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-refused-race");
      await seedChat(seeded);

      // A concurrent attempt refuses this submission after the watch exists under the
      // reserved id, so the ledger's winner keeps naming that id.
      let reservedWatchId = "";
      const result = await submit({
        seeded,
        chatId: "chat_1",
        create: async (createParams) => {
          reservedWatchId = createParams.watchId!;
          const created = await createDashboardAgentWatch(createParams);
          const refused = await recordWatchSubmissionOutcome(ctx.agentDb, {
            chatId: "chat_1",
            clientRequestId: "wreq_1",
            state: "refused",
            refusalCode: "internal",
            refusalError: "That watch couldn't be started.",
          });
          expect(refused).toMatchObject({ state: "refused", watchId: reservedWatchId });
          return created;
        },
      });

      // The user is told nothing is being watched, so nothing may be watching.
      expect(result.ok).toBe(false);
      const row = await getWatch(ctx.agentDb, { id: reservedWatchId });
      expect(row).toMatchObject({ status: "cancelled", cancelReason: "superseded" });
    }
  );

  postgresTest(
    "the consent record never spends a message from the cap",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-quota");
      await seedChat(seeded);

      await submit({ seeded, chatId: "chat_1" });

      expect(
        await countUserMessages(ctx.agentDb, {
          organizationId: seeded.organization.id,
          userId: seeded.user.id,
        })
      ).toBe(0);
    }
  );

  postgresTest(
    "a replay repeats the recorded email outcome and subscribes nobody",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-external-replay");
      await seedChat(seeded);

      const draft = draftFor(RUN_START, { notifyExternally: true });

      // The first attempt asked for email and couldn't get it, so `unavailable` is what
      // the transcript says and what the ledger records.
      const first = await submit({ seeded, chatId: "chat_1", draft, subscribed: false });
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(JSON.stringify(first.messages)).toContain("I couldn't add email notifications");
      expect(
        await getWatchSubmission(ctx.agentDb, { chatId: "chat_1", clientRequestId: "wreq_1" })
      ).toMatchObject({ state: "created", externalNotificationStatus: "unavailable" });

      const transcript = await storedMessages(seeded, "chat_1");

      // The retry gets the real subscribe, which would succeed here. A replay that took the
      // decision again would leave a channel row and an `enabled` answer the transcript —
      // append-once, so never rewritten — contradicts for good.
      let subscribeCalls = 0;
      const retry = await submit({
        seeded,
        chatId: "chat_1",
        draft,
        subscribe: async (subscribeParams) => {
          subscribeCalls++;
          return subscribeUserToWatchAlerts(subscribeParams);
        },
      });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);
      expect(retry.watchId).toBe(first.watchId);
      expect(subscribeCalls).toBe(0);

      expect(JSON.stringify(retry.messages)).toContain("I couldn't add email notifications");
      expect(JSON.stringify(retry.messages)).not.toContain("You'll get an email");
      expect(
        await prisma.projectAlertChannel.count({ where: { projectId: seeded.project.id } })
      ).toBe(0);
      expect(
        await getWatchSubmission(ctx.agentDb, { chatId: "chat_1", clientRequestId: "wreq_1" })
      ).toMatchObject({ externalNotificationStatus: "unavailable" });

      // The symptom: what the user is told after a refresh has to agree with the answer.
      expect(await storedMessages(seeded, "chat_1")).toEqual(transcript);
    }
  );

  postgresTest(
    "a replay repeats the recorded 'Watching' confirmation after the watch has fired",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "submit-replay-fired");
      await seedChat(seeded);

      const first = await submit({ seeded, chatId: "chat_1" });
      expect(first.ok).toBe(true);
      if (!first.ok || !first.watchId) return;

      await transitionWatchCondition(ctx.agentDb, {
        id: first.watchId,
        resolution: "condition_met",
      });

      const retry = await submit({ seeded, chatId: "chat_1" });

      expect(retry.ok).toBe(true);
      if (!retry.ok) return;
      expect(retry.repaired).toBe(true);

      // The recorded outcome is replayed, never decided again: the append-once
      // confirmation in the transcript says "Watching", so the answer has to as well.
      const parts = retry.messages.at(-1)?.parts ?? [];
      const block = (parts[0] as any).data.blocks[0];
      expect(block.outcome).toBe("watching");
      expect(block.headline).toContain("Watching");
    }
  );
});

describe("appendChatMessageOnce", () => {
  postgresTest(
    "appends in order without rewriting the transcript",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "append");
      await seedChat(seeded);

      const first = { id: "watch-card:watch_1", role: "assistant", parts: [] };
      const second = { id: "watch-card:watch_2", role: "assistant", parts: [] };

      expect(
        await appendChatMessageOnce(ctx.agentDb, {
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
          message: first,
        })
      ).toBe(true);
      await appendChatMessageOnce(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
        message: second,
      });

      const messages = await getChatMessages(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });
      expect(messages).toEqual([first, second]);
    }
  );

  postgresTest(
    "appends nothing for a chat the caller doesn't own",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "append-owner");
      await seedChat(seeded);

      expect(
        await appendChatMessageOnce(ctx.agentDb, {
          chatId: "chat_1",
          userId: "user_someone_else",
          organizationId: seeded.organization.id,
          message: { id: "watch-card:watch_1", role: "assistant", parts: [] },
        })
      ).toBe(false);

      const messages = await getChatMessages(ctx.agentDb, {
        chatId: "chat_1",
        userId: seeded.user.id,
        organizationId: seeded.organization.id,
      });
      expect(messages).toEqual([]);
    }
  );
});

describe("run_failed creation", () => {
  const RUN_FAILED: WatchSpec = {
    kind: "run_failed",
    runId: "run_1",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me if it fails",
  };

  postgresTest(
    "watches a running run and dedups against the finished variant separately",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "runfailed");
      await seedChat(seeded);

      const failed = await create({
        seeded,
        spec: RUN_FAILED,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING" }) },
      });
      expect(failed.ok).toBe(true);
      if (!failed.ok || !failed.watching) return;
      expect(failed.identity).toBe("run_failed:run_1");

      const finished = await create({
        seeded,
        spec: { ...RUN_FAILED, kind: "run_finished" } as WatchSpec,
        checkDeps: { readRun: async () => runRow({ status: "EXECUTING" }) },
      });
      expect(finished.ok).toBe(true);
      if (!finished.ok || !finished.watching) return;
      expect(finished.identity).toBe("run_finished:run_1");
    }
  );

  postgresTest(
    "answers outright, with no watch row, once the run has succeeded",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "runfailed-done");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: RUN_FAILED,
        checkDeps: {
          readRun: async () =>
            runRow({ status: "COMPLETED_SUCCESSFULLY", completedAt: new Date() }),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );
});

describe("the queue pack creation", () => {
  const QUEUE = "task/my-task";

  const BELOW: WatchSpec = {
    kind: "queue_depth_below",
    queue: QUEUE,
    threshold: 100,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me when it's back below 100",
  };

  const STALLED: WatchSpec = {
    kind: "queue_stalled",
    queue: QUEUE,
    ticks: 3,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me if it stops moving",
  };

  const AGE: WatchSpec = {
    kind: "queue_oldest_age",
    queue: QUEUE,
    thresholdMinutes: 5,
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "tell me if runs wait longer than 5 minutes",
  };

  postgresTest(
    "creates each kind with its own identity on the same queue",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuepack");
      await seedChat(seeded);

      const busy = {
        readQueueDepth: async () => ({
          depth: 780,
          source: "live_queue" as const,
          current: true,
        }),
      };

      const below = await create({ seeded, spec: BELOW, checkDeps: busy });
      expect(below.ok && below.watching).toBe(true);
      if (!below.ok || !below.watching) return;
      expect(below.identity).toBe(`queue_depth_below:${QUEUE}:100`);

      const stalled = await create({ seeded, spec: STALLED, checkDeps: busy });
      expect(stalled.ok && stalled.watching).toBe(true);
      if (!stalled.ok || !stalled.watching) return;
      expect(stalled.identity).toBe(`queue_stalled:${QUEUE}`);

      const age = await create({ seeded, spec: AGE, checkDeps: busy });
      expect(age.ok && age.watching).toBe(true);
      if (!age.ok || !age.watching) return;
      expect(age.identity).toBe(`queue_oldest_age:${QUEUE}:5`);

      const drain = await create({
        seeded,
        spec: { ...BELOW, kind: "backlog_drain" } as WatchSpec,
        checkDeps: busy,
      });
      expect(drain.ok).toBe(false);
      if (drain.ok) return;
      expect(drain.code).toBe("limit_reached");
    }
  );

  postgresTest(
    "dedups the same SLA and allows a different one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queueage");
      await seedChat(seeded);

      const first = await create({ seeded, spec: AGE });
      expect(first.ok && first.watching).toBe(true);

      const same = await create({ seeded, spec: AGE });
      expect(same.ok).toBe(false);
      if (same.ok) return;
      expect(same.code).toBe("duplicate");

      const other = await create({ seeded, spec: { ...AGE, thresholdMinutes: 30 } as WatchSpec });
      expect(other.ok && other.watching).toBe(true);
      if (!other.ok || !other.watching) return;
      expect(other.identity).toBe(`queue_oldest_age:${QUEUE}:30`);
    }
  );

  postgresTest(
    "answers a back-below ask outright when the queue is already quiet",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuebelow");
      await seedChat(seeded);

      const result = await create({
        seeded,
        spec: BELOW,
        checkDeps: {
          readQueueDepth: async () => ({ depth: 4, source: "live_queue", current: true }),
        },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("satisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );

  postgresTest(
    "round-trips the stall state through the row's existing facts column",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "queuestall");
      await seedChat(seeded);

      const created = await create({
        seeded,
        spec: STALLED,
        checkDeps: {
          readQueueDepth: async () => ({ depth: 42, source: "live_queue", current: true }),
        },
      });
      expect(created.ok && created.watching).toBe(true);
      if (!created.ok || !created.watching) return;

      const facts = { queue: QUEUE, depth: 42, notDecreasingStreak: 2, ticks: 3 };
      await recordWatchCheck(ctx.agentDb, {
        id: created.watchId,
        lastResult: {
          result: "pending",
          facts,
          observed: {
            kind: "queue_stalled",
            verified: true,
            depth: 42,
            notDecreasingStreak: 2,
            ticks: 3,
          },
          final: false,
        },
      });

      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(previousCheckFacts(row?.lastResult)).toEqual(facts);

      await recordWatchCheck(ctx.agentDb, {
        id: created.watchId,
        lastResult: { checkFailed: true, detail: "clickhouse down", previous: facts },
      });
      const afterGap = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(previousCheckFacts(afterGap?.lastResult)).toEqual(facts);
    }
  );
});

const HEALTH: WatchSpec = {
  kind: "health_recovery",
  report: "health",
  fromSeverity: "warn",
  checkEveryMinutes: 5,
  maxHours: 6,
  note: "tell me when health recovers",
};

describe("the batch chain registry", () => {
  postgresTest("arms one chain per group, and only one", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "batcharm");
    const now = new Date();

    const scheduled: Array<{ epoch: number; tick: number }> = [];
    const arm = () =>
      armDashboardAgentWatchBatch({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        now,
        deps: {
          schedule: async (params) =>
            void scheduled.push({ epoch: params.epoch, tick: params.tick }),
        },
      });

    expect(await arm()).toEqual({ running: true });
    expect(scheduled).toEqual([{ epoch: 1, tick: 1 }]);

    expect(await arm()).toEqual({ running: true });
    expect(await arm()).toEqual({ running: true });
    expect(scheduled).toHaveLength(1);
  });

  postgresTest(
    "a chain whose run died is re-armed on a fresh epoch, and the zombie claims nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchdead");
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      const scheduled: Array<{ epoch: number; tick: number }> = [];
      const arm = (now: Date) =>
        armDashboardAgentWatchBatch({
          ...group,
          now,
          deps: {
            schedule: async (params) =>
              void scheduled.push({ epoch: params.epoch, tick: params.tick }),
          },
        });

      const armedAt = new Date();
      await arm(armedAt);
      expect(
        await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 1 })
      ).toMatchObject({ epoch: 1, generation: 1 });

      await arm(new Date(armedAt.getTime() + 60_000));
      expect(scheduled).toHaveLength(1);

      await arm(new Date(armedAt.getTime() + watchBatchStaleMs(5) + 60_000));
      expect(scheduled).toEqual([
        { epoch: 1, tick: 1 },
        { epoch: 2, tick: 1 },
      ]);

      expect(await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 2 })).toBe(
        null
      );
      expect(
        await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 2, generation: 1 })
      ).toMatchObject({ epoch: 2, generation: 1 });
    }
  );

  postgresTest(
    "a chain that couldn't be triggered is not left marked as running",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchfail");
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      expect(
        await armDashboardAgentWatchBatch({
          ...group,
          deps: {
            schedule: async () => {
              throw new Error("the trigger failed");
            },
          },
        })
      ).toEqual({ running: false });

      const scheduled: number[] = [];
      expect(
        await armDashboardAgentWatchBatch({
          ...group,
          deps: { schedule: async (params) => void scheduled.push(params.epoch) },
        })
      ).toEqual({ running: true });
      expect(scheduled).toEqual([2]);
    }
  );

  postgresTest(
    "the re-arm backstop finds groups with active watches and no chain",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchrearm");
      await seedChat(seeded);
      const created = await create({
        seeded,
        spec: HEALTH,
        checkDeps: { readHealth: async () => null },
      });
      expect(created.ok).toBe(true);

      const groups = await listWatchBatchGroupsToArm(ctx.agentDb);
      expect(groups).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);

      const armed: Array<{ environmentId: string; cadenceMinutes: number }> = [];
      expect(
        await rearmDashboardAgentWatchBatches({
          configured: () => true,
          arm: async (params) => {
            armed.push({
              environmentId: params.environmentId,
              cadenceMinutes: params.cadenceMinutes,
            });
            return { running: true };
          },
        })
      ).toEqual({ stale: 1, armed: 1, failed: 0 });
      expect(armed).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);

      // The staleness window is the group's own cadence: a five-minute group goes stale 17 minutes later.
      await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        staleBefore: new Date(),
      });
      expect(await listWatchBatchGroupsToArm(ctx.agentDb)).toEqual([]);
      expect(
        await listWatchBatchGroupsToArm(ctx.agentDb, {
          now: new Date(Date.now() + watchBatchStaleMs(5) + 60_000),
        })
      ).toEqual([{ environmentId: seeded.environment.id, cadenceMinutes: 5 }]);
    }
  );

  postgresTest(
    "groups are per environment and per cadence, never mixed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchgroup");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");
      expect((await create({ seeded, chatId: "chat_1", spec: HEALTH })).ok).toBe(true);
      expect((await create({ seeded, chatId: "chat_2", spec: RUN_START })).ok).toBe(true);

      const five = await listActiveWatchesForBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
      });
      const one = await listActiveWatchesForBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 1,
      });

      expect(five.map((watch) => watch.chatId)).toEqual(["chat_1"]);
      expect(one.map((watch) => watch.chatId)).toEqual(["chat_2"]);
      expect(
        (await listWatchBatchGroupsToArm(ctx.agentDb)).sort(
          (a, b) => a.cadenceMinutes - b.cadenceMinutes
        )
      ).toEqual([
        { environmentId: seeded.environment.id, cadenceMinutes: 1 },
        { environmentId: seeded.environment.id, cadenceMinutes: 5 },
      ]);
    }
  );
});

describe("the batch check", () => {
  async function healthGroup(seeded: Seeded, count = 3) {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const chatId = `chat_${index + 1}`;
      await seedChat(seeded, chatId);
      const created = await create({
        seeded,
        chatId,
        spec: HEALTH,
        // `warn` keeps them all pending, so the group stays whole for the assertions below.
        checkDeps: { readHealth: async () => ({ trustworthy: true, severity: "warn" }) },
      });
      if (!created.ok || !created.watching) throw new Error("the watch wasn't created");
      ids.push(created.watchId);
    }
    return ids;
  }

  async function otherUsersWatch(seeded: Seeded, prisma: PrismaClient) {
    const user = await prisma.user.create({
      data: {
        email: `other_${seeded.organization.slug}@example.com`,
        authenticationMethod: "MAGIC_LINK",
      },
    });
    await prisma.orgMember.create({
      data: { organizationId: seeded.organization.id, userId: user.id, role: "MEMBER" },
    });
    await createChat(ctx.agentDb, {
      id: "chat_other",
      organizationId: seeded.organization.id,
      userId: user.id,
    });
    const created = await createDashboardAgentWatch({
      environment: authenticated(seeded),
      userId: user.id,
      chatId: "chat_other",
      spec: HEALTH,
      deps: {
        configured: () => true,
        checkDeps: () =>
          fakeCheckDeps({ readHealth: async () => ({ trustworthy: true, severity: "warn" }) }),
        scheduleTick: async () => {},
      },
    });
    if (!created.ok || !created.watching) throw new Error("the watch wasn't created");
    return { userId: user.id, watchId: created.watchId };
  }

  async function armChain(seeded: Seeded, cadenceMinutes = 5) {
    const row = await armWatchBatch(ctx.agentDb, {
      environmentId: seeded.environment.id,
      cadenceMinutes,
      staleBefore: new Date(),
    });
    if (!row) throw new Error("the chain wasn't armed");
    return row;
  }

  postgresTest(
    "authorizes once and loads the shared report once for the whole group",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchcheck");
      const ids = await healthGroup(seeded);
      const chain = await armChain(seeded);

      let healthReads = 0;
      let authorizations = 0;

      const response = await runWatchBatchCheck(
        {
          environmentId: seeded.environment.id,
          cadenceMinutes: 5,
          epoch: chain.epoch,
          tick: 1,
        },
        {
          authorize: async () => {
            authorizations++;
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () =>
            fakeCheckDeps({
              readHealth: async () => {
                healthReads++;
                return { trustworthy: true, severity: "warn" };
              },
            }),
        }
      );

      expect(authorizations).toBe(1);
      expect(healthReads).toBe(1);

      expect(response.watches?.map((entry) => entry.watchId).sort()).toEqual([...ids].sort());
      expect(response.watches?.every((entry) => entry.result === "pending")).toBe(true);
      expect(response.watches?.every((entry) => entry.tick === 1)).toBe(true);
      expect(response.watches?.every((entry) => entry.token.length > 0)).toBe(true);
      expect(response.continues).toBe(true);
      expect(response.stale).toBeUndefined();

      for (const id of ids) {
        expect((await getWatch(ctx.agentDb, { id }))?.lastResult).toMatchObject({
          result: "pending",
          final: false,
        });
      }
    }
  );

  postgresTest(
    "authorizes each distinct user, so sharing readers never shares access",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchusers");
      await healthGroup(seeded, 2);
      const other = await otherUsersWatch(seeded, prisma);

      const chain = await armChain(seeded);
      const authorized: string[] = [];

      await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async (watch) => {
            authorized.push(watch.userId);
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(authorized.sort()).toEqual([other.userId, seeded.user.id].sort());
    }
  );

  postgresTest(
    "cancels a watch whose user lost access, and still answers for its neighbours",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchrevoked");
      const ids = await healthGroup(seeded, 2);
      const chain = await armChain(seeded);

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async () => ({ ok: false, reason: "access_revoked" }),
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(response.watches?.every((entry) => entry.code === "access_revoked")).toBe(true);
      for (const id of ids) {
        expect(await getWatch(ctx.agentDb, { id })).toMatchObject({
          status: "cancelled",
          cancelReason: "access_revoked",
          deliveryStatus: "not_required",
        });
      }
    }
  );

  postgresTest(
    "checks what is due, skips what isn't, and never skips a window boundary",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchdue");
      const [fresh, overdue, boundary] = await healthGroup(seeded, 3);
      const chain = await armChain(seeded);
      const now = new Date();

      await recordWatchCheck(ctx.agentDb, { id: fresh!, lastCheckedAt: now });
      await recordWatchCheck(ctx.agentDb, {
        id: overdue!,
        lastCheckedAt: new Date(now.getTime() - 10 * 60_000),
      });
      // `boundary`'s window closes before the next tick, so its final evaluation must still happen.
      await recordWatchCheck(ctx.agentDb, { id: boundary!, lastCheckedAt: now });
      await prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() + interval '1 minute' where id = $1`,
        boundary
      );

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          now: () => now,
          authorize: async () => ({ ok: true, environment: authenticated(seeded) }),
          checkDeps: () => fakeCheckDeps(),
        }
      );

      expect(response.watches?.map((entry) => entry.watchId).sort()).toEqual(
        [boundary!, overdue!].sort()
      );
      expect(response.continues).toBe(true);
    }
  );

  postgresTest(
    "a stale tick claims nothing and checks nothing",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchstale");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);

      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch };
      expect((await runWatchBatchCheck({ ...group, tick: 1 })).stale).toBeUndefined();
      expect((await runWatchBatchCheck({ ...group, tick: 2 })).stale).toBeUndefined();

      const late = await runWatchBatchCheck({ ...group, tick: 1 });
      expect(late).toEqual({ stale: true });

      expect(await runWatchBatchCheck({ ...group, epoch: chain.epoch - 1, tick: 1 })).toEqual({
        stale: true,
      });
      expect((await getWatch(ctx.agentDb, { id: ids[0]! }))?.status).toBe("active");
    }
  );

  postgresTest(
    "stops the chain when the group's last watch is gone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchempty");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);
      await cancelWatch(ctx.agentDb, { id: ids[0]!, reason: "user" });

      const response = await runWatchBatchCheck({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        epoch: chain.epoch,
        tick: 1,
      });

      expect(response).toMatchObject({ watches: [], continues: false });

      const rearmed = await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        // Deliberately in the past: only a stopped chain can be re-armed this way.
        staleBefore: new Date(Date.now() - 60 * 60_000),
      });
      expect(rearmed).toMatchObject({ epoch: chain.epoch + 1, status: "running" });
    }
  );

  postgresTest(
    "hands the group's owed wakes back for redelivery",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchowed");
      const ids = await healthGroup(seeded, 2);
      const chain = await armChain(seeded);

      await transitionWatchCondition(ctx.agentDb, {
        id: ids[0]!,
        resolution: "condition_met",
        lastResult: { verified: true },
      });

      const response = await runWatchBatchCheck({
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        epoch: chain.epoch,
        tick: 1,
      });

      const owed = response.watches?.filter((entry) => entry.deliverOnly === true) ?? [];
      expect(owed.map((entry) => entry.watchId)).toEqual([ids[0]!]);
      expect(owed[0]?.tick).toBe(0);
      expect(
        response.watches?.filter((entry) => !entry.deliverOnly).map((entry) => entry.watchId)
      ).toEqual([ids[1]!]);
    }
  );

  postgresTest(
    "keeps the chain alive while a wake is still owed, even with nothing left to watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchowedlast");
      const ids = await healthGroup(seeded, 1);
      const chain = await armChain(seeded);
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5 };

      await transitionWatchCondition(ctx.agentDb, {
        id: ids[0]!,
        resolution: "condition_met",
        lastResult: { verified: true },
      });

      const first = await runWatchBatchCheck({ ...group, epoch: chain.epoch, tick: 1 });
      expect(first.continues).toBe(true);
      expect(first.watches?.map((entry) => entry.deliverOnly)).toEqual([true]);

      const claim = await claimWatchDelivery(ctx.agentDb, {
        id: ids[0]!,
        staleBefore: new Date(Date.now() - WATCH_DELIVERY_CLAIM_STALE_MS),
      });
      await markWatchDelivered(ctx.agentDb, { id: ids[0]!, claimId: claim!.claimId });

      const second = await runWatchBatchCheck({ ...group, epoch: chain.epoch, tick: 2 });
      expect(second).toMatchObject({ watches: [], continues: false });
      expect(await stopWatchBatch(ctx.agentDb, { ...group, epoch: chain.epoch })).toBe(null);
    }
  );

  postgresTest(
    "one watch that throws mid-evaluation costs only that watch",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchthrow");
      const mine = await healthGroup(seeded, 2);
      const theirs = await otherUsersWatch(seeded, prisma);
      const chain = await armChain(seeded);

      const response = await runWatchBatchCheck(
        { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch, tick: 1 },
        {
          authorize: async (watch) => {
            if (watch.userId === theirs.userId) throw new Error("the authorization query failed");
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () => fakeCheckDeps(),
          concurrency: 1,
        }
      );

      const byId = new Map(response.watches?.map((entry) => [entry.watchId, entry]));
      expect(byId.get(theirs.watchId)).toMatchObject({ result: "unavailable" });
      expect((await getWatch(ctx.agentDb, { id: theirs.watchId }))?.status).toBe("active");
      for (const id of mine) {
        expect(byId.get(id)).toMatchObject({ result: "pending" });
      }
    }
  );
});

describe("the batch check endpoint's authorization", () => {
  function batchRequest(body: unknown, token?: string) {
    return new Request("https://app.trigger.dev/api/v1/dashboard-agent/watches/batch-check", {
      method: "POST",
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
  }

  const batchToken = (environmentId: string, cadenceMinutes: number) =>
    signDashboardAgentWatchBatchToken(SESSION_SECRET, {
      environmentId,
      cadenceMinutes,
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });

  postgresTest("refuses a missing or bad token", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const body = { environmentId: "env_1", cadenceMinutes: 5, epoch: 1, tick: 1 };

    expect(
      (await batchCheckAction({ request: batchRequest(body), params: {}, context: {} })).status
    ).toBe(401);
    const watchToken = await signDashboardAgentWatchToken(SESSION_SECRET, {
      watchId: "watch_1",
      expiresAt: new Date(Date.now() + 60 * 60_000),
    });
    expect(
      (await batchCheckAction({ request: batchRequest(body, watchToken), params: {}, context: {} }))
        .status
    ).toBe(401);
  });

  postgresTest(
    "refuses a token minted for another group",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const token = await batchToken("env_1", 5);

      const wrongCadence = await batchCheckAction({
        request: batchRequest(
          { environmentId: "env_1", cadenceMinutes: 15, epoch: 1, tick: 1 },
          token
        ),
        params: {},
        context: {},
      });
      expect(wrongCadence.status).toBe(403);
      expect(await wrongCadence.json()).toMatchObject({ code: "group_mismatch" });

      const wrongEnvironment = await batchCheckAction({
        request: batchRequest(
          { environmentId: "env_2", cadenceMinutes: 5, epoch: 1, tick: 1 },
          token
        ),
        params: {},
        context: {},
      });
      expect(wrongEnvironment.status).toBe(403);
    }
  );

  postgresTest(
    "answers a group it does own, through the real registry",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchroute");
      const chain = await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        staleBefore: new Date(),
      });
      const token = await batchToken(seeded.environment.id, 5);

      const response = await batchCheckAction({
        request: batchRequest(
          {
            environmentId: seeded.environment.id,
            cadenceMinutes: 5,
            epoch: chain!.epoch,
            tick: 1,
          },
          token
        ),
        params: {},
        context: {},
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ watches: [], continues: false });
      expect(
        await stopWatchBatch(ctx.agentDb, {
          environmentId: seeded.environment.id,
          cadenceMinutes: 5,
          epoch: chain!.epoch,
        })
      ).toBe(null);
    }
  );
});
