/**
 * The queue detail page presents a task queue's name with the `task/` prefix stripped, but
 * `TaskQueue.name` keeps it — and nobody asking for a watch can tell which kind of queue
 * they are naming. Creation resolves the name against the environment and rewrites the spec
 * to the stored one, so the identity and the depth readers never see the other spelling.
 */

import {
  createChat,
  createDashboardAgentDb,
  getWatch,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import type { WatchSpec } from "@internal/dashboard-agent-contracts";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
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
  readNames.length = 0;
});

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

/** One org, project and production environment, holding a task queue and a custom one. */
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
  // A custom queue, stored under the plain name the user gave it.
  await prisma.taskQueue.create({
    data: {
      friendlyId: `queue_${suffix()}`,
      name: "worker-1",
      orderableName: "worker-1",
      type: "NAMED",
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
function checkDeps(seeded: Seeded, readNames: string[]): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: (name: string) => watchQueueExistsOnPrimary(seeded.environment.id, name),
    readQueueDepth: async () => ({ depth: 3, source: "live_queue", current: true }),
    readQueueOldestAge: async (name: string) => {
      readNames.push(name);
      return { ageMs: 1_000, source: "live_queue", current: true };
    },
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
  };
}

/** The names the depth readers were handed, so a spec left un-rewritten is visible. */
const readNames: string[] = [];

async function createFor(seeded: Seeded, spec: WatchSpec, chatId?: string) {
  const id = chatId ?? `chat_${suffix()}`;
  if (!chatId) {
    await createChat(ctx.agentDb, {
      id,
      organizationId: seeded.organization.id,
      userId: seeded.user.id,
    });
  }
  return createDashboardAgentWatch({
    environment: authenticated(seeded),
    userId: seeded.user.id,
    chatId: id,
    spec,
    deps: {
      configured: () => true,
      checkDeps: () => checkDeps(seeded, readNames),
      scheduleTick: async () => {},
    },
  });
}

async function persistedQueueName(created: { watchId?: string }) {
  if (!created.watchId) {
    throw new Error("Expected the created watch to have an ID");
  }

  const watch = await getWatch(ctx.agentDb, { id: created.watchId });
  if (!watch) {
    throw new Error(`Expected watch ${created.watchId} to exist`);
  }

  return (watch.spec as { queue: string }).queue;
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
    },
    30_000
  );

  postgresTest(
    "is created under the stored name when the display name reaches the spec",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const created = await createFor(seeded, queueWatchRecommendation(PRESENTED.name));
      expect(created).toMatchObject({ ok: true, watching: true });
      expect(await persistedQueueName(created as { watchId: string })).toBe("task/send-receipt");
      expect(readNames).toEqual(["task/send-receipt"]);
    },
    30_000
  );
});

describe("a watch on a custom queue", () => {
  postgresTest(
    "is created under the plain name when the model adds the `task/` prefix",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const created = await createFor(seeded, queueWatchRecommendation("task/worker-1"));
      expect(created).toMatchObject({ ok: true, watching: true });
      expect(await persistedQueueName(created as { watchId: string })).toBe("worker-1");
      expect(readNames).toEqual(["worker-1"]);
    },
    30_000
  );

  postgresTest(
    "dedupes across both spellings, because the identity sees the stored name",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);
      const chatId = `chat_${suffix()}`;
      await createChat(ctx.agentDb, {
        id: chatId,
        organizationId: seeded.organization.id,
        userId: seeded.user.id,
      });

      const first = await createFor(seeded, queueWatchRecommendation("worker-1"), chatId);
      expect(first).toMatchObject({ ok: true, watching: true });

      const second = await createFor(seeded, queueWatchRecommendation("task/worker-1"), chatId);
      expect(second).toMatchObject({
        ok: false,
        code: "duplicate",
        existingId: (first as { watchId: string }).watchId,
      });
    },
    30_000
  );
});

describe("a queue that exists under neither spelling", () => {
  postgresTest(
    "is refused, either way round",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      expect(await createFor(seeded, queueWatchRecommendation("worker-9"))).toMatchObject({
        ok: false,
        code: "invalid_target",
      });
      expect(await createFor(seeded, queueWatchRecommendation("task/worker-9"))).toMatchObject({
        ok: false,
        code: "invalid_target",
      });
    },
    30_000
  );
});
