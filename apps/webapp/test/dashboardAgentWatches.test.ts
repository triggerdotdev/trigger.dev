// Watch creation + the private check endpoint, against a REAL Postgres.
//
// No fake datastore: the container runs both schemas — Prisma's (for the
// authorization query) and the dashboard-agent schema (for the watch rows) — so
// the guardrails under test are the real ones: the partial unique index behind
// dedup, the ≤3 limit, the `WHERE status = 'active'` transitions, and the
// membership-scoped authorization SQL.
//
// Only two things are injected rather than executed: the ClickHouse / run-queue
// readers (through the service's `checkDeps` seam) and the tick trigger
// (`scheduleTick`).
import {
  appendChatMessage,
  armWatchBatch,
  cancelWatch,
  chatExists,
  claimWatchBatchTick,
  claimWatchDelivery,
  claimWatchTick,
  listActiveWatchesForBatch,
  listWatchBatchGroupsToArm,
  stopWatchBatch,
  countUnreadWatchWakes,
  createChat,
  createDashboardAgentDb,
  getChatMessages,
  getWatch,
  listActiveWatchesForChat,
  listChatIdsWithUnreadWakes,
  listRecentWatchWakes,
  markWatchDelivered,
  recordWatchCheck,
  releaseWatchDelivery,
  transitionWatchCondition,
  WATCH_DELIVERY_CLAIM_STALE_MS,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
  type Watch,
} from "@internal/dashboard-agent-db";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import {
  previousCheckFacts,
  type WatchCheckDeps,
  type WatchRunRow,
} from "~/services/dashboardAgentWatchChecks";

// --- Holders, wired per test into the mocked singletons ----------------------
const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  canAccess: true,
  /**
   * The delegated user-actor the create endpoint sees, if any. `environmentId` is
   * the environment scope the dashboard minted the turn's token with — the
   * authority the endpoint binds a watch to.
   */
  actor: undefined as undefined | { userId: string; client?: string; environmentId?: string },
}));

// The shared UAT preamble. The create endpoint accepts ONLY a dashboard-agent
// user-actor token, so the tests drive the claims it would resolve.
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

// `~/db.server` — the authorization query runs for real against the container.
vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

// The agent store — a real Drizzle client on the same container.
vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

// The feature gate is a peripheral here; toggled per test to prove it's consulted.
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => ctx.canAccess,
}));

// The check endpoint verifies watch tokens with `env.SESSION_SECRET`. Pin it here
// and hand the same string to the signer, so the suite never imports the env
// schema just to read one value.
const SESSION_SECRET = "test-session-secret-for-watch-tokens";
process.env.SESSION_SECRET = SESSION_SECRET;

const {
  armDashboardAgentWatchBatch,
  authorizeWatchEnvironment,
  createDashboardAgentWatch,
  deleteChatWithWatches,
  listActiveWatchesForChats,
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

// --- Fixtures ---------------------------------------------------------------

/**
 * Apply the dashboard-agent schema by replaying its Drizzle migration SQL —
 * every migration in the folder, in order, so a new migration can never leave
 * this suite running against a stale schema (a fixed list once did).
 */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  const migrations = readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort();
  for (const name of migrations) {
    const sql = readFileSync(path.join(folder, name), "utf8");
    for (const statement of sql.split("--> statement-breakpoint")) {
      const trimmed = statement.trim();
      if (trimmed.length > 0) await prisma.$executeRawUnsafe(trimmed);
    }
  }
}

let agentDbClient: DashboardAgentDbClient | undefined;

/** Both schemas live, both clients pointed at this test's database clone. */
async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyAgentSchema(prisma);
  // A pool, not a single connection: the limit test fires concurrent creates and
  // the advisory lock they serialize on only means anything across connections.
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

/** The already-authorized environment the service takes. */
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

/** Create a watch with the readers and the tick trigger injected. */
/**
 * A run that exists for the target validation and is gone by the time the
 * immediate check reads it — the `condition_impossible` one-shot.
 */
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

      // The first tick carries the GENERATION it will claim — `tickCount + 1` —
      // so it can't be confused with a reschedule of the same generation.
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.watchId).toBe(result.watchId);
      expect(scheduled[0]!.tick).toBe(1);
      // The token travels in the payload; it is never stored on the row.
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
        // Off unless the user asked for it, and the project's external ref is
        // on the row so a wake can scope an investigation the way a turn does.
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
      // It is an action flag, not identity: the dedup string is unchanged.
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

  // §2.2/§4.1: the immediate check answers the request outright, and the answer
  // is a ONE-SHOT RESULT BLOCK — not a watch that resolves in the same breath.
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
      // The status-aware observation travels with it, so the caller can word the
      // block without going back to the source.
      expect(result.immediate.observed).toMatchObject({ kind: "run_start", started: true });
      // Nothing to wait for, so no tick is scheduled at all.
      expect(ticks).toBe(0);

      // The whole point: NO row. No chip, no delivery claim, and no wake that
      // could tell the user the same thing a second time.
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
        // Validated as existing, then gone by the time the check reads it.
        checkDeps: { readRun: readRunOnce(runRow({ status: "QUEUED" })) },
      });

      expect(result.ok).toBe(true);
      if (!result.ok || result.watching) throw new Error("expected a one-shot result");
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  // The guardrails come BEFORE the immediate check (§4.4), so the refusal does
  // not depend on whether the condition happens to be true right now.
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
      // One read for target validation, and no check after the refusal.
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
      // Cancelled, not resolved: nobody evaluated the user's condition, so there
      // is nothing to narrate — and a cancellation is always silent.
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

      // A different environment is a different thing to watch, same spec or not.
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

      // Four DIFFERENT conditions, so dedup can't be what rejects any of them —
      // only the count-then-insert guardrail can, and it has to hold even when all
      // four read the count at the same time (each on its own pool connection).
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

// The agent-facing adapter. Only the refusals are driven through the route here:
// the happy path would trigger the real watcher task, which belongs to the
// service-level tests above.
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
      // A turn minted without an environment. There is nothing to fall back to
      // that this endpoint would trust, so the watch is refused outright.
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
      // A second project + environment in the SAME org, so the org cross-check
      // can't be what refuses anything below.
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

      // The chat's stored snapshot names project/env A…
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
      // …and the current turn is in project/env B.
      ctx.actor = {
        userId: seeded.user.id,
        client: "dashboard-agent",
        environmentId: otherEnvironment.id,
      };

      // The snapshot's project is a mismatch against the token's environment. If
      // the snapshot were the authority this request would have been accepted.
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
      // The user is a member of both orgs, so the environment authorizes — only the
      // chat/environment org cross-check stands between them.
      await prisma.orgMember.create({
        data: {
          organizationId: other.organization.id,
          userId: seeded.user.id,
          role: "ADMIN",
        },
      });
      await seedChat(seeded, "chat_1");

      // A token minted in the other org's environment for a chat in this one.
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

      expect(await deleteChatWithWatches({ chatId: "chat_1", userId: seeded.user.id })).toEqual({
        deleted: true,
        cancelledWatches: 1,
      });

      // The chat is gone and its watch went with it — neither half can land alone.
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
      // Another chat's watch is untouched.
      expect(await getWatch(ctx.agentDb, { id: theirs.watchId })).toMatchObject({
        status: "active",
      });
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

      // Terminal watches drop off the chips.
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
      // The toast feed lists recent DELIVERIES (read or not) inside a window.
      const recent = { ...scope, deliveredAfter: new Date(Date.now() - 15 * 60 * 1000) };

      // Terminal but undelivered: the chat has no message to open yet, so the
      // launcher's dot and the toast must stay quiet.
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
          // A snapshot/row mismatch must never resolve.
          projectId: other.project.id,
          environmentId: seeded.environment.id,
        })
      ).toEqual({ ok: false, reason: "access_revoked" });
    }
  );
});

// The backstop. Everything here runs against the REAL query layer — the point of
// these tests is the wiring: which rows the sweep can actually see, and that a
// finalization goes through the same authorization a tick's check does.
describe("the watch sweep", () => {
  /** An overdue active watch: created normally, then backdated past its deadline. */
  async function overdueWatch(seeded: Seeded, chatId = "chat_1") {
    const created = await create({ seeded, chatId });
    if (!created.ok) throw new Error("the watch wasn't created");
    await ctx.prisma.$executeRawUnsafe(
      `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 hour' where id = $1`,
      created.watchId
    );
    return created.watchId;
  }

  /** The seams: real store, injected readers, and a recorded delivery. */
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
          // The condition became true right at the deadline: the sweep's last check
          // has to see it, exactly as the tick's final check would.
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
      // The wake is handed to the watcher task, which owns the session append.
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
      // The check ran, so the narration may say the condition didn't happen.
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
        // A cancellation is never narrated.
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

      // First sweep: the row is expired with the delivery owed, and scheduling the
      // wake fails. The row is no longer `active`, so from here on only the
      // delivery query can see it at all.
      const delivered: string[] = [];
      await expect(
        sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, failDelivery: true }))
      ).rejects.toThrow(/failed on 1 watches/);
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        status: "expired",
        deliveryStatus: "pending",
      });
      expect(delivered).toEqual([]);

      // The retry, once the delivery grace has passed. Nothing re-decides the
      // outcome; the wake is simply handed over — and only once.
      const later = new Date(Date.now() + WATCH_DELIVERY_GRACE_MS + 60_000);
      const second = await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }));
      expect(second).toMatchObject({ undelivered: 1, redelivered: 1, failed: 0 });
      expect(delivered).toEqual([watchId]);

      // Delivered for real (the watcher task marks it), so a third sweep sees nothing.
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

      // The watcher claimed the wake and hasn't marked it delivered. The outcome is
      // old enough to be past the delivery grace, but a fresh claim is somebody's to
      // hold — the sweep must not take it away.
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

      // The claim is stale: that deliverer died, and nothing else will ever pick the
      // wake up — so the sweep does.
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

  // Under the resolution model an immediate answer never becomes a row, so there
  // is no "inline outcome" for the sweep to recover: the one-shot result block IS
  // the complete delivery (§7.5). What the sweep still owns is the wake for a
  // watch that actually ran and resolved — covered above.
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

      // The configuration vanished after the watch was created (a rotated secret, a
      // rollback). The row must still be finalized, or it holds a watch slot and
      // blocks re-asking forever.
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

      // Configured again: the outcome the user was promised is handed over.
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

      // A second past the deadline: the chain's own final check owns this window.
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set expires_at = now() - interval '1 second' where id = $1`,
        created.watchId
      );
      const delivered: string[] = [];
      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered }))).toMatchObject({
        overdue: 0,
      });

      // Past the grace, the backstop takes over.
      const later = new Date(Date.now() + WATCH_EXPIRY_GRACE_MS + 60_000);
      expect(
        await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered, now: later }))
      ).toMatchObject({ overdue: 1, expired: 1 });
    }
  );

  postgresTest(
    "retention drops long-terminal rows and nothing else",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      await seedChat(seeded, "chat_2");
      await seedChat(seeded, "chat_3");

      // Three rows, one per outcome the retention has to distinguish.
      const old = await overdueWatch(seeded, "chat_1");
      const recent = await overdueWatch(seeded, "chat_2");
      await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }));
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_status = 'delivered', delivered_at = now()
         where id in ($1, $2)`,
        old,
        recent
      );

      const active = await create({ seeded, chatId: "chat_3" });
      if (!active.ok || !active.watching) throw new Error("expected an active watch");

      // Only the first is past the window. Backdate every timestamp the age is
      // measured from, so `greatest(...)` really is old.
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set created_at = now() - interval '30 days',
             fired_at = now() - interval '30 days',
             last_checked_at = now() - interval '30 days',
             delivered_at = now() - interval '30 days'
         where id = $1`,
        old
      );
      // The active row is ancient too — status, not age, is what protects it.
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches set created_at = now() - interval '30 days' where id = $1`,
        active.watchId
      );

      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }))).toMatchObject({
        purged: 1,
        failed: 0,
      });
      expect(await getWatch(ctx.agentDb, { id: old })).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: recent })).not.toBeNull();
      expect(await getWatch(ctx.agentDb, { id: active.watchId })).not.toBeNull();
    }
  );

  postgresTest(
    "retention never takes a row whose wake is still owed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "sweep");
      await seedChat(seeded);
      const watchId = await overdueWatch(seeded);

      // Resolved a month ago and still `pending`: retention must leave it for the
      // delivery half, or the user silently never gets an outcome they were promised.
      await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }));
      await ctx.prisma.$executeRawUnsafe(
        `update trigger_dashboard_agent.watches
         set delivery_status = 'pending',
             created_at = now() - interval '30 days',
             fired_at = now() - interval '30 days',
             last_checked_at = now() - interval '30 days'
         where id = $1`,
        watchId
      );

      expect(await sweepDashboardAgentWatches(sweepDeps({ seeded, delivered: [] }))).toMatchObject({
        purged: 0,
      });
      expect(await getWatch(ctx.agentDb, { id: watchId })).not.toBeNull();
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

      // A claim whose check then never ran must leave no trace of an observation —
      // the expiry narration reports `lastCheckedAt` as when the watch was last
      // looked at, and a failed claim's timestamp would be a lie.
      const claimed = await claimWatchTick(ctx.agentDb, { id: created.watchId, generation: 1 });
      expect(claimed).toMatchObject({ tickCount: 1, lastCheckedAt: null, lastResult: null });

      // The check that did run writes the pair together.
      await recordWatchCheck(ctx.agentDb, { id: created.watchId, lastResult: { pending: 4 } });
      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(row?.lastCheckedAt).toBeInstanceOf(Date);
      expect(row?.lastResult).toMatchObject({ pending: 4 });
      // And the claim is still the only writer of the counter.
      expect(row?.tickCount).toBe(1);
    }
  );
});

// The delivery claim's fencing token. The status alone can't say WHOSE claim is in
// the row, and a deliverer that hangs past the stale window is taken over — so
// without the token its release would hand the new owner's claim back to `pending`
// (a third deliverer then appends in parallel with the second) and its late mark
// would close out a delivery it never made.
describe("the delivery claim", () => {
  /** A resolved watch with its wake owed, and the current staleness cutoff. */
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

  /** Age the claim past the stale window, i.e. the deliverer that holds it died. */
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

      // A claims and hangs.
      const a = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(a).not.toBeNull();
      if (!a) return;

      // Five minutes later B takes the abandoned claim over, on a NEW token.
      await ageClaim(watchId);
      const b = await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() });
      expect(b).not.toBeNull();
      if (!b) return;
      expect(b.claimId).not.toBe(a.claimId);

      // A wakes up, its append fails, and it releases — the claim it releases is no
      // longer its own, so nothing moves. Without the token this would put the row
      // back to `pending` while B is still appending.
      expect(
        await releaseWatchDelivery(ctx.agentDb, { id: watchId, claimId: a.claimId })
      ).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveryClaimId: b.claimId,
      });

      // So C finds a claim that is fresh and somebody's to hold, and delivers nothing.
      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();

      // B is the only deliverer, and its mark closes the row out exactly once.
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

      // A's append landed somewhere long ago (or never); either way its mark must not
      // finish B's delivery, which would leave the wake never appended and the row
      // closed. Nor may the unfenced mark — the inline path's — touch a live claim.
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId, claimId: a.claimId })).toBeNull();
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      expect(await getWatch(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivering",
        deliveredAt: null,
      });

      // B still owns the delivery and can still complete it.
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

      // The one caller that never claims: an outcome resolved inline with nothing to
      // narrate later. It closes out an owed, unclaimed row — and only that.
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toMatchObject({
        deliveryStatus: "delivered",
      });
      expect(await markWatchDelivered(ctx.agentDb, { id: watchId })).toBeNull();
      // A delivered wake can't be re-claimed either.
      expect(
        await claimWatchDelivery(ctx.agentDb, { id: watchId, staleBefore: staleBefore() })
      ).toBeNull();
    }
  );
});

// The delete/create race. The chat lock is what makes these two orderings have the
// same outcome, and the invariant is one-sided: an active watch on a deleted chat
// has nowhere to deliver anything, so it must never exist.
describe("deleting a chat while a watch is being created", () => {
  postgresTest("holds in both orders", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    const seeded = await seed(prisma, "race");

    for (const deleteFirst of [true, false]) {
      const chatId = `chat_${deleteFirst ? "del" : "add"}`;
      await seedChat(seeded, chatId);

      const creating = () => create({ seeded, chatId });
      const deleting = () => deleteChatWithWatches({ chatId, userId: seeded.user.id });
      // Both orderings of the same interleave: whichever takes the lock first, the
      // other must not be able to leave a live watch behind.
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
      await deleteChatWithWatches({ chatId: "chat_1", userId: seeded.user.id });

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

  async function activeWatch(seeded: Seeded) {
    const result = await create({ seeded });
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
    // The REAL readers run on this path, and no such run exists in this
    // environment — so the honest answer is that it can never start.
    expect(body.result).toBe("terminal_unsatisfied");

    const row = await getWatch(ctx.agentDb, { id: watch.watchId });
    expect(row?.lastCheckedAt).not.toBeNull();
    // The generation claim is the task's, not this endpoint's, so the counter is
    // untouched here.
    expect(row?.tickCount).toBe(0);
    // Still active: the fire/expire transition belongs to the watcher task.
    expect(row?.status).toBe("active");
  });

  postgresTest(
    "refuses an ordinary check after expiry but allows the final one in grace",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "check");
      await seedChat(seeded);
      const watch = await activeWatch(seeded);

      // Backdate the deadline: the ROW is the authority on expiry.
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

      // Membership gone -> the tick must observe nothing at all.
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
        // Cancellation is never notified.
        deliveryStatus: "not_required",
      });
      // No check ran, so nothing was recorded.
      expect(row?.tickCount).toBe(0);
      expect(row?.lastResult).toBeNull();
    }
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

// The deterministic transcript append behind the configuration card's submit
// path (§2.2): the confirmation and the one-shot result block are host-decided
// facts, written with no turn and no LLM, so the append itself has to be atomic
// and owner-scoped.
describe("appendChatMessage", () => {
  postgresTest(
    "appends in order without rewriting the transcript",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "append");
      await seedChat(seeded);

      const first = { id: "watch-card:watch_1", role: "assistant", parts: [] };
      const second = { id: "watch-card:watch_2", role: "assistant", parts: [] };

      expect(
        await appendChatMessage(ctx.agentDb, {
          chatId: "chat_1",
          userId: seeded.user.id,
          organizationId: seeded.organization.id,
          message: first,
        })
      ).toBe(true);
      await appendChatMessage(ctx.agentDb, {
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
        await appendChatMessage(ctx.agentDb, {
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

// The card's second run condition, end to end through the real creation path.
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

      // "When it finishes" and "if it fails" are two different questions about
      // the same run, so the second one is not a duplicate of the first.
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
      // The one-shot path: it can never fail now, so there is nothing to watch.
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("terminal_unsatisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );
});

// The queue pack (TRI-12890) through the real creation path: three more questions
// about one queue, each with its own identity, plus the stateful check reading its
// own previous facts off the row.
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

      // A backed-up queue: nothing here is already true, so all three are watching.
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
      // The stall sensitivity is not in the identity — one queue, one "is it moving?".
      expect(stalled.identity).toBe(`queue_stalled:${QUEUE}`);

      const age = await create({ seeded, spec: AGE, checkDeps: busy });
      expect(age.ok && age.watching).toBe(true);
      if (!age.ok || !age.watching) return;
      expect(age.identity).toBe(`queue_oldest_age:${QUEUE}:5`);

      // Three distinct questions, so no dedup between them — but the chat cap is 3,
      // so a fourth queue question is refused rather than silently dropped.
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

      // "Longer than 30 minutes" is a different promise about the same queue.
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
      // The one-shot path: it is already below, so there is nothing to watch.
      expect(result.watching).toBe(false);
      if (result.watching) return;
      expect(result.immediate.result).toBe("satisfied");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toEqual([]);
    }
  );

  // The stateful seam against the real column: the streak lives in the facts the
  // existing `recordWatchCheck` already persists — NO new column — and the check
  // endpoint hands the next check whatever `previousCheckFacts` reads back off it.
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

      // What the check endpoint writes after a pending tick.
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

      // And after a FAILED tick, which is what the watcher task parks: the gap is
      // unwrapped, so the last real observation is still the previous one and the
      // streak neither grows nor resets.
      await recordWatchCheck(ctx.agentDb, {
        id: created.watchId,
        lastResult: { checkFailed: true, detail: "clickhouse down", previous: facts },
      });
      const afterGap = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(previousCheckFacts(afterGap?.lastResult)).toEqual(facts);
    }
  );
});

// ---------------------------------------------------------------------------
// Batching — one polling loop and one set of reads per (environment, cadence).
//
// Against the real registry table and the real guarded SQL, because that is where
// "exactly one chain per group" and "a zombie chain claims nothing" actually live.
// ---------------------------------------------------------------------------

/** A health-recovery watch: the one whose check reads the shared report. */
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

    // The first arm starts a chain at generation 1 of epoch 1.
    expect(await arm()).toEqual({ running: true });
    expect(scheduled).toEqual([{ epoch: 1, tick: 1 }]);

    // Everything after it joins the live chain instead of starting a second one —
    // that IS the batching: N watches, one run per cadence.
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
      // The chain ticks once, then its run dies.
      expect(
        await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 1 })
      ).toMatchObject({ epoch: 1, generation: 1 });

      // Inside the heartbeat window nothing is re-armed.
      await arm(new Date(armedAt.getTime() + 60_000));
      expect(scheduled).toHaveLength(1);

      // Past it, a new epoch takes over.
      await arm(new Date(armedAt.getTime() + watchBatchStaleMs(5) + 60_000));
      expect(scheduled).toEqual([
        { epoch: 1, tick: 1 },
        { epoch: 2, tick: 1 },
      ]);

      // The zombie wakes up and tries to tick epoch 1 again: it owns nothing.
      expect(await claimWatchBatchTick(ctx.agentDb, { ...group, epoch: 1, generation: 2 })).toBe(
        null
      );
      // And the replacement's own chain is unharmed.
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

      // Nothing polls the group, and the caller is told so — a per-watch tick keeps
      // its own chain alive rather than handing over to a chain that doesn't exist.
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

      // The row is stopped, so the very next arm can try again immediately.
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

      // The watch exists and nothing is polling its group.
      const groups = await listWatchBatchGroupsToArm(ctx.agentDb, {
        staleBefore: new Date(),
      });
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

      // Once a chain is heartbeating, the group is no longer stale.
      await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        staleBefore: new Date(),
      });
      expect(
        await listWatchBatchGroupsToArm(ctx.agentDb, {
          staleBefore: new Date(Date.now() - watchBatchStaleMs(60)),
        })
      ).toEqual([]);
    }
  );

  postgresTest(
    "groups are per environment and per cadence, never mixed",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "batchgroup");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");
      // Two cadences in one environment: 5 (health) and 1 (run_start).
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
      // Each cadence gets its own chain.
      expect(
        (await listWatchBatchGroupsToArm(ctx.agentDb, { staleBefore: new Date() })).sort(
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
  /** Three health watches in one environment, one per chat, all on cadence 5. */
  async function healthGroup(seeded: Seeded, count = 3) {
    const ids: string[] = [];
    for (let index = 0; index < count; index++) {
      const chatId = `chat_${index + 1}`;
      await seedChat(seeded, chatId);
      const created = await create({
        seeded,
        chatId,
        spec: HEALTH,
        // `warn` keeps every one of them pending, so nothing resolves and the group
        // stays whole for the assertions below.
        checkDeps: { readHealth: async () => ({ trustworthy: true, severity: "warn" }) },
      });
      if (!created.ok || !created.watching) throw new Error("the watch wasn't created");
      ids.push(created.watchId);
    }
    return ids;
  }

  /**
   * A SECOND user's watch in the same environment and cadence. Authorization is
   * memoized per user, so this is what proves the memo is per user and not per group.
   */
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

  /** A chain armed straight in the registry, so a tick can claim its generation. */
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

      // THE point of the change: three watches, one authorization, one report load.
      expect(authorizations).toBe(1);
      expect(healthReads).toBe(1);

      // And a verdict per watch, each with its own generation to claim.
      expect(response.watches?.map((entry) => entry.watchId).sort()).toEqual([...ids].sort());
      expect(response.watches?.every((entry) => entry.result === "pending")).toBe(true);
      expect(response.watches?.every((entry) => entry.tick === 1)).toBe(true);
      expect(response.watches?.every((entry) => entry.token.length > 0)).toBe(true);
      expect(response.continues).toBe(true);
      expect(response.stale).toBeUndefined();

      // Every row records what its check saw, exactly as the single endpoint does.
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

      // Two users, two authorizations — memoized per user, never skipped.
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

      // Both are refused, and neither is narrated: a cancellation is silent.
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

      // `fresh` was checked seconds ago: a cadence hasn't elapsed.
      await recordWatchCheck(ctx.agentDb, { id: fresh!, lastCheckedAt: now });
      // `overdue` was checked ten minutes ago — two cadences.
      await recordWatchCheck(ctx.agentDb, {
        id: overdue!,
        lastCheckedAt: new Date(now.getTime() - 10 * 60_000),
      });
      // `boundary` was checked seconds ago too, but its window closes before the next
      // tick would come round — so §7.4's final evaluation must still happen.
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
      // The group is still whole, so the chain keeps ticking.
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

      // Generation 1 runs…
      const group = { environmentId: seeded.environment.id, cadenceMinutes: 5, epoch: chain.epoch };
      expect((await runWatchBatchCheck({ ...group, tick: 1 })).stale).toBeUndefined();
      // …and 2 after it, so a late duplicate of 1 owns nothing.
      expect((await runWatchBatchCheck({ ...group, tick: 2 })).stale).toBeUndefined();

      const late = await runWatchBatchCheck({ ...group, tick: 1 });
      expect(late).toEqual({ stale: true });

      // A zombie from an older epoch is equally powerless.
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

      // The chain is stopped, so a watch created next arms a fresh epoch rather than
      // joining a loop that has already ended.
      const rearmed = await armWatchBatch(ctx.agentDb, {
        environmentId: seeded.environment.id,
        cadenceMinutes: 5,
        // Deliberately in the past: only a STOPPED chain can be re-armed this way.
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

      // One of them resolved and its wake never landed — the state a batch run that
      // failed one append leaves behind.
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
      // Delivery-only entries decide nothing, so they carry no generation.
      expect(owed[0]?.tick).toBe(0);
      // The other one was checked normally.
      expect(
        response.watches?.filter((entry) => !entry.deliverOnly).map((entry) => entry.watchId)
      ).toEqual([ids[1]!]);
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
            // Not a refusal — a broken authorization READ, which is the failure that
            // happens before any reader is built and is not shared with other users.
            if (watch.userId === theirs.userId) throw new Error("the authorization query failed");
            return { ok: true, environment: authenticated(seeded) };
          },
          checkDeps: () => fakeCheckDeps(),
          // Serialized, so the failure can't be masked by ordering.
          concurrency: 1,
        }
      );

      const byId = new Map(response.watches?.map((entry) => [entry.watchId, entry]));
      // The broken one is `unavailable`: never read as true, never as false, and the
      // row keeps its state for the next tick.
      expect(byId.get(theirs.watchId)).toMatchObject({ result: "unavailable" });
      expect((await getWatch(ctx.agentDb, { id: theirs.watchId }))?.status).toBe("active");
      // Its neighbours were answered.
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
    // A watch token is not a chain token, however valid it is.
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

      // Right environment, wrong cadence.
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

      // Right cadence, wrong environment.
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
      // No watches in the group, so the chain is told to stop.
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
