/**
 * The queue detail page presents a task queue's name with the `task/` prefix stripped, but
 * `TaskQueue.name` keeps it — so the name the page hands a watch has to be the stored one,
 * or every task-queue watch is refused as a missing target.
 */

import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, vi } from "vitest";
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

process.env.SESSION_SECRET = "test-session-secret-for-watch-queue-names";

const { createDashboardAgentWatch } = await import("~/services/dashboardAgentWatches.server");
const { watchQueueExistsOnPrimary } = await import("~/services/dashboardAgentWatchChecks.server");
const { storedQueueName } = await import("~/components/queues/queue-name");
const { queueWatchRecommendation } =
  await import("~/components/dashboard-agent/watch-recommendations");

/** Replays every migration in order, so a new migration can't leave this file on a stale schema. */
async function applyAgentSchema(prisma: PrismaClient) {
  const folder = path.resolve(__dirname, "../../../internal-packages/dashboard-agent-db/drizzle");
  for (const name of readdirSync(folder)
    .filter((file) => file.endsWith(".sql"))
    .sort()) {
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

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** One org, project and production environment, holding one virtual queue for `send-receipt`. */
async function seed(prisma: PrismaClient) {
  const slug = `queue_name_${suffix()}`;
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
  // A task's own queue, exactly as `createBackgroundWorker` writes it.
  await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${suffix()}`,
      name: "task/send-receipt",
      orderableName: "task/send-receipt",
      type: "VIRTUAL",
      projectId: project.id,
      runtimeEnvironmentId: environment.id,
    },
  });

  await createChat(ctx.agentDb, {
    id: `chat_${suffix()}`,
    organizationId: organization.id,
    userId: user.id,
  });

  return { user, organization, project, environment };
}

type Seeded = Awaited<ReturnType<typeof seed>>;

function authenticated(seeded: Seeded) {
  return {
    id: seeded.environment.id,
    organizationId: seeded.organization.id,
    projectId: seeded.project.id,
    slug: seeded.environment.slug,
    type: seeded.environment.type,
    project: { id: seeded.project.id, externalRef: seeded.project.externalRef },
    organization: { id: seeded.organization.id, slug: seeded.organization.slug },
  } as any;
}

/** Only `queueExists` is real: it is the read the target validation is decided by. */
function checkDeps(seeded: Seeded): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: (name: string) => watchQueueExistsOnPrimary(seeded.environment.id, name),
    readQueueDepth: async () => ({ depth: 3, source: "live_queue", current: true }),
    readQueueOldestAge: async () => ({ ageMs: 1_000, source: "live_queue", current: true }),
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
  };
}

async function createFor(seeded: Seeded, spec: WatchSpec) {
  const chatId = `chat_${suffix()}`;
  await createChat(ctx.agentDb, {
    id: chatId,
    organizationId: seeded.organization.id,
    userId: seeded.user.id,
  });
  return createDashboardAgentWatch({
    environment: authenticated(seeded),
    userId: seeded.user.id,
    chatId,
    spec,
    deps: {
      configured: () => true,
      checkDeps: () => checkDeps(seeded),
      scheduleTick: async () => {},
    },
  });
}

/** The queue as `QueueRetrievePresenter` hands it to the page: the prefix already stripped. */
const PRESENTED = { type: "task", name: "send-receipt" };

describe("a watch on a task's own queue", () => {
  postgresTest(
    "validates, because the page sends the stored name",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const spec = queueWatchRecommendation(storedQueueName(PRESENTED), { oldestWaitMs: null });
      expect(spec).toMatchObject({ queue: "task/send-receipt" });

      const created = await createFor(seeded, spec);
      expect(created).toMatchObject({ ok: true, watching: true });
    }
  );

  postgresTest(
    "is refused when the display name reaches the spec instead",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const created = await createFor(seeded, queueWatchRecommendation(PRESENTED.name));
      expect(created).toMatchObject({ ok: false, code: "invalid_target" });
    }
  );
});
