import {
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";

// The submit's idempotency key identifies one card submission. A per-condition fallback would
// identify the condition instead, so a re-watch could replay a stale terminal outcome inside the
// retention window. The key is required, and a submit without one must create nothing.

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  agentDb: undefined as unknown as DashboardAgentDb,
  userId: "",
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: ctx.userId, admin: false, isImpersonating: false }),
}));

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));

process.env.SESSION_SECRET = "test-session-secret-for-watch-card-request-id";

const { action } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");

let agentDbClient: DashboardAgentDbClient | undefined;

async function seed(prisma: PrismaClient) {
  const slug = `card_req_${Math.random().toString(36).slice(2, 10)}`;
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
  await prisma.runtimeEnvironment.create({
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
  ctx.userId = user.id;
  return { user, organization, project };
}

const DRAFT = JSON.stringify({
  spec: {
    kind: "run_start",
    runId: "run_1",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me when it starts",
  },
  followUp: { investigateOnAttention: false, notifyExternally: false },
});

function submitRequest(slug: string, body: Record<string, string>) {
  const form = new URLSearchParams(body);
  return action({
    request: new Request(
      `https://app.trigger.dev/resources/orgs/${slug}/projects/${slug}/env/prod/dashboard-agent`,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    ),
    params: { organizationSlug: slug, projectParam: slug, envParam: "prod" },
    context: {},
  } as never) as Promise<Response>;
}

async function countRows(prisma: PrismaClient, table: "watches" | "watch_submissions") {
  const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
    `select count(*)::bigint as count from trigger_dashboard_agent.${table}`
  );
  return Number(rows[0]?.count ?? 0);
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the watch card submit's request id", () => {
  postgresTest(
    "refuses a submit with no clientRequestId, and creates nothing",
    async ({ prisma, postgresContainer }) => {
      ctx.prisma = prisma;
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 4 });
      ctx.agentDb = agentDbClient.db;

      const seeded = await seed(prisma);

      const response = await submitRequest(seeded.organization.slug, {
        intent: "watch-create",
        draft: DRAFT,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ code: "invalid_request" });

      // No ledger row and no watch: the submit was refused before either could be written.
      expect(await countRows(prisma, "watch_submissions")).toBe(0);
      expect(await countRows(prisma, "watches")).toBe(0);

      // The same body with a key gets past this refusal, so the 400 above is the key's.
      const withKey = await submitRequest(seeded.organization.slug, {
        intent: "watch-create",
        draft: DRAFT,
        clientRequestId: "wreq_1",
      });
      expect(await withKey.json()).not.toMatchObject({ code: "invalid_request" });
    }
  );
});
