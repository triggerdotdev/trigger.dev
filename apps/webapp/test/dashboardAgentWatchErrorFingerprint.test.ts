/**
 * The errors page cites an error as `error_<fingerprint>` and the agent's own tools cite the
 * bare fingerprint. Both name the same error, so both must produce the same watch identity —
 * otherwise one error carries two watches, two wakes and two emails per recurrence.
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

const { createDashboardAgentWatch } = await import("~/services/dashboardAgentWatches.server");

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

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(prisma: PrismaClient) {
  const slug = `fingerprint_${suffix()}`;
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
  await createChat(ctx.agentDb, { id: chatId, organizationId: organization.id, userId: user.id });

  return { user, organization, project, environment, chatId };
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

/** Quiet so far, so a recurrence watch is created rather than answered on the spot. */
function checkDeps(): WatchCheckDeps {
  return {
    readRun: async () => null,
    queueExists: async () => true,
    readQueueDepth: async () => null,
    readQueueOldestAge: async () => null,
    readErrorRecurrence: async () => null,
    readHealth: async () => null,
  };
}

const FINGERPRINT = "9f3c1ab27de4";

function recurrenceSpec(fingerprint: string): WatchSpec {
  return {
    kind: "error_recurrence",
    fingerprint,
    checkEveryMinutes: 5,
    maxHours: 6,
    note: "tell me if it comes back",
  };
}

function createFor(seeded: Seeded, fingerprint: string) {
  return createDashboardAgentWatch({
    environment: authenticated(seeded),
    userId: seeded.user.id,
    chatId: seeded.chatId,
    spec: recurrenceSpec(fingerprint),
    deps: {
      configured: () => true,
      checkDeps: () => checkDeps(),
      scheduleTick: async () => {},
    },
  });
}

describe("a watch on one error", () => {
  postgresTest(
    "stores the bare fingerprint, whichever spelling the caller cites",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const created = await createFor(seeded, `error_${FINGERPRINT}`);
      expect(created).toMatchObject({
        ok: true,
        watching: true,
        identity: `error_recurrence:${FINGERPRINT}`,
      });
      if (!created.ok || !created.watching) return;

      // The wake builds its `trigger://` link straight from the stored spec.
      const row = await getWatch(ctx.agentDb, { id: created.watchId });
      expect(row?.spec).toMatchObject({ fingerprint: FINGERPRINT });
    }
  );

  postgresTest(
    "is one watch, not two, when the two spellings are both submitted",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const seeded = await seed(prisma);

      const first = await createFor(seeded, `error_${FINGERPRINT}`);
      expect(first).toMatchObject({ ok: true, watching: true });

      const second = await createFor(seeded, FINGERPRINT);
      expect(second).toMatchObject({ ok: false, code: "duplicate" });
    }
  );
});
