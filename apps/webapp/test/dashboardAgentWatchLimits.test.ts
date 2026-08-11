import {
  countActiveWatchesForOrg,
  createChat,
  createDashboardAgentDb,
  listActiveWatchesForChat,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import type * as TriggerSdk from "@trigger.dev/sdk";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WatchCheckDeps, WatchRunRow } from "~/services/dashboardAgentWatchChecks";
import type { WatchPlanLimits } from "~/services/dashboardAgentWatchLimits.server";

vi.setConfig({ testTimeout: 60_000 });

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

vi.mock("@trigger.dev/sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof TriggerSdk>();
  return {
    ...actual,
    TriggerClient: class {
      tasks = { trigger: async () => ({ id: "run_test" }) };
    },
  };
});

process.env.SESSION_SECRET = "test-session-secret-for-watch-limits";

const { createDashboardAgentWatch } = await import("~/services/dashboardAgentWatches.server");
const { effectiveWatchMaxHours, watchLimitHint, UNLIMITED_WATCH_LIMIT } =
  await import("~/services/dashboardAgentWatchLimits.server");

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

async function boot(prisma: PrismaClient, connectionUri: string) {
  ctx.prisma = prisma;
  await applyAgentSchema(prisma);
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 4 });
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

async function seedChat(seeded: Seeded, chatId: string) {
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

const UNLIMITED: WatchPlanLimits = {
  maxHours: UNLIMITED_WATCH_LIMIT,
  watchers: UNLIMITED_WATCH_LIMIT,
};

function runStart(runId: string, maxHours = 2): WatchSpec {
  return { kind: "run_start", runId, checkEveryMinutes: 1, maxHours, note: "tell me" };
}

function create(args: {
  seeded: Seeded;
  spec: WatchSpec;
  chatId: string;
  limits?: WatchPlanLimits;
  billingConfigured?: boolean;
  countActiveWatches?: (organizationId: string) => Promise<number>;
}) {
  return createDashboardAgentWatch({
    environment: authenticated(args.seeded),
    userId: args.seeded.user.id,
    chatId: args.chatId,
    spec: args.spec,
    deps: {
      configured: () => true,
      checkDeps: () => fakeCheckDeps(),
      scheduleTick: async () => {},
      resolveLimits: async () => args.limits ?? UNLIMITED,
      ...(args.countActiveWatches ? { countActiveWatches: args.countActiveWatches } : {}),
      ...(args.billingConfigured === undefined
        ? {}
        : { billingConfigured: () => args.billingConfigured! }),
    },
  });
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("watch plan limits (pure)", () => {
  it("caps the window ceiling at the code ceiling of 24 hours", () => {
    expect(effectiveWatchMaxHours(100)).toBe(24);
    expect(effectiveWatchMaxHours(1)).toBe(1);
    expect(effectiveWatchMaxHours(0.5)).toBe(0.5);
  });

  it("adds an upgrade nudge only when billing is configured", () => {
    expect(watchLimitHint("too long.", true)).toBe("too long. Upgrade your plan for more.");
    expect(watchLimitHint("too long.", false)).toBe("too long.");
  });
});

describe("createDashboardAgentWatch plan enforcement", () => {
  postgresTest(
    "refuses a window longer than the plan allows",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "window");
      await seedChat(seeded, "chat_1");

      const result = await create({
        seeded,
        chatId: "chat_1",
        spec: runStart("run_1", 2),
        limits: { maxHours: 1, watchers: UNLIMITED_WATCH_LIMIT },
        billingConfigured: true,
      });

      expect(result).toMatchObject({ ok: false, code: "watch_limit_reached" });
      if (result.ok) return;
      expect(result.error).toContain("Upgrade your plan");
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(0);
    }
  );

  postgresTest(
    "creates a watch whose window is within the plan",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "within");
      await seedChat(seeded, "chat_1");

      const result = await create({
        seeded,
        chatId: "chat_1",
        spec: runStart("run_1", 1),
        limits: { maxHours: 1, watchers: UNLIMITED_WATCH_LIMIT },
      });

      expect(result.ok).toBe(true);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(1);
    }
  );

  postgresTest(
    "refuses once the org is at its watcher count, counting active watches for real",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "count");
      await seedChat(seeded, "chat_1");
      await seedChat(seeded, "chat_2");

      const limits: WatchPlanLimits = { maxHours: UNLIMITED_WATCH_LIMIT, watchers: 1 };

      const first = await create({ seeded, chatId: "chat_1", spec: runStart("run_1"), limits });
      expect(first.ok).toBe(true);
      expect(
        await countActiveWatchesForOrg(ctx.agentDb, { organizationId: seeded.organization.id })
      ).toBe(1);

      const second = await create({ seeded, chatId: "chat_2", spec: runStart("run_2"), limits });
      expect(second).toMatchObject({ ok: false, code: "watch_limit_reached" });
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_2" })).toHaveLength(0);
    }
  );

  postgresTest(
    "fails open: an absent limit resolves to unlimited and a 2h watch is created",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "failopen");
      await seedChat(seeded, "chat_1");

      const result = await create({
        seeded,
        chatId: "chat_1",
        spec: runStart("run_1", 2),
        limits: UNLIMITED,
      });

      expect(result.ok).toBe(true);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(1);
    }
  );

  postgresTest(
    "leaves no upgrade nudge on a refusal when billing is unconfigured",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "selfhosted");
      await seedChat(seeded, "chat_1");

      const result = await create({
        seeded,
        chatId: "chat_1",
        spec: runStart("run_1", 2),
        limits: { maxHours: 1, watchers: UNLIMITED_WATCH_LIMIT },
        billingConfigured: false,
      });

      expect(result).toMatchObject({ ok: false, code: "watch_limit_reached" });
      if (result.ok) return;
      expect(result.error).not.toContain("Upgrade");
    }
  );

  postgresTest(
    "min semantics: a plan of 100 hours still permits only up to the 24h ceiling",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma, "minsem");
      await seedChat(seeded, "chat_1");

      const created = await create({
        seeded,
        chatId: "chat_1",
        spec: runStart("run_1", 24),
        limits: { maxHours: 100, watchers: UNLIMITED_WATCH_LIMIT },
      });
      expect(created.ok).toBe(true);
      expect(await listActiveWatchesForChat(ctx.agentDb, { chatId: "chat_1" })).toHaveLength(1);
    }
  );
});
