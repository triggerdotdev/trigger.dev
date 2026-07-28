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
  createChat,
  createDashboardAgentDb,
  getWatch,
  listActiveWatchesForChat,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, vi } from "vitest";
import type { WatchCheckDeps, WatchRunRow } from "~/services/dashboardAgentWatchChecks";

// --- Holders, wired per test into the mocked singletons ----------------------
const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  canAccess: true,
  /** The delegated user-actor the create endpoint sees, if any. */
  actor: undefined as undefined | { userId: string; client?: string },
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

const {
  authorizeWatchEnvironment,
  cancelWatchesForDeletedChat,
  createDashboardAgentWatch,
  listActiveWatchesForChats,
} = await import("~/services/dashboardAgentWatches.server");
const { action: checkAction } =
  await import("~/routes/api.v1.dashboard-agent.watches.$watchId.check");
const { action: createAction } = await import("~/routes/api.v1.dashboard-agent.watches");
const { signDashboardAgentWatchToken } = await import("~/services/dashboardAgentWatchToken.server");
const { env } = await import("~/env.server");

// --- Fixtures ---------------------------------------------------------------

const AGENT_MIGRATIONS = [
  "0000_magenta_lilandra",
  "0001_slimy_living_tribunal",
  "0002_luxuriant_king_cobra",
];

/** Apply the dashboard-agent schema by replaying its Drizzle migration SQL. */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  for (const name of AGENT_MIGRATIONS) {
    const sql = readFileSync(path.join(folder, `${name}.sql`), "utf8");
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
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
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
    readQueueDepth: async () => ({ depth: 7, source: "live_queue" }),
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
function create(args: {
  seeded: Seeded;
  spec?: WatchSpec;
  chatId?: string;
  environmentId?: string;
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

      // The first tick's key is indexed by the row's CURRENT tickCount (0) — the
      // pairing that keeps it from colliding with the task's first reschedule.
      expect(scheduled).toHaveLength(1);
      expect(scheduled[0]!.watchId).toBe(result.watchId);
      expect(scheduled[0]!.tick).toBe(0);
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
      });
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
    "resolves inline when the condition already holds",
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
      if (!result.ok) return;
      expect(result.status).toBe("fired");
      expect(result.immediate?.result).toBe("satisfied");
      // Nothing to wait for, so no tick is scheduled at all.
      expect(ticks).toBe(0);

      const row = await getWatch(ctx.agentDb, { id: result.watchId });
      // Narrated in this very response, so the delivery is already closed out.
      expect(row).toMatchObject({ status: "fired", deliveryStatus: "delivered" });
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
    ctx.actor = { userId: seeded.user.id, client: "cli" };

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
        metadata: {
          context: {
            environmentId: owner.environment.id,
            projectRef: owner.project.externalRef,
          },
        },
      });

      ctx.actor = { userId: stranger.user.id, client: "dashboard-agent" };

      const response = await post(validBody("chat_victim"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "chat_not_found" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_victim" })).toHaveLength(
        0
      );
    }
  );

  postgresTest(
    "refuses a chat with no environment context",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "nocontext");
      await seedChat(seeded, "chat_1");
      ctx.actor = { userId: seeded.user.id, client: "dashboard-agent" };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
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
      await createChat(ctx.agentDb, {
        id: "chat_1",
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
        metadata: { context: { environmentId: other.environment.id } },
      });

      ctx.actor = { userId: seeded.user.id, client: "dashboard-agent" };

      const response = await post(validBody("chat_1"));
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({ code: "invalid_target" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );
});

describe("the chat cascade and the list view", () => {
  postgresTest(
    "deleting a chat cancels its active watches with reason chat_deleted",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "cascade");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const mine = await create({ seeded, chatId: "chat_1" });
      const theirs = await create({ seeded, chatId: "chat_2" });
      expect(mine.ok && theirs.ok).toBe(true);
      if (!mine.ok || !theirs.ok) return;

      expect(await cancelWatchesForDeletedChat("chat_1")).toBe(1);

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

      const byChat = await listActiveWatchesForChats(["chat_1", "chat_2", "chat_missing"]);
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
      await cancelWatchesForDeletedChat("chat_1");
      expect((await listActiveWatchesForChats(["chat_1"])).chat_1).toBeUndefined();
    }
  );

  postgresTest("returns nothing for an empty chat list", async ({ prisma, postgresContainer }) => {
    await boot(prisma, postgresContainer.getConnectionUri());
    expect(await listActiveWatchesForChats([])).toEqual({});
  });
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
    return signDashboardAgentWatchToken(env.SESSION_SECRET, { watchId, expiresAt });
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

  postgresTest("answers a check and records the tick", async ({ prisma, postgresContainer }) => {
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
    expect(row?.tickCount).toBe(1);
    expect(row?.lastCheckedAt).not.toBeNull();
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
