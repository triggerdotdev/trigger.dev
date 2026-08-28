import {
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, describe, expect, vi } from "vitest";
import type * as WatchLimitsModule from "~/services/dashboardAgentWatchLimits.server";

// A plan-limit refusal (`watch_limit_reached`) is a 409, not a 500. The card submit's status
// ladder must map it the same way the MCP route does, or a full org sees an "unexpected error".

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

// The only stub: the plan floor billing would resolve. A 1-hour window makes a 2-hour watch
// exceed the plan, so the real submit path returns `watch_limit_reached`. Everything else runs.
vi.mock("~/services/dashboardAgentWatchLimits.server", async (importOriginal) => {
  const actual = await importOriginal<typeof WatchLimitsModule>();
  return {
    ...actual,
    resolveWatchPlanLimits: async () => ({
      maxHours: 1,
      watchers: actual.UNLIMITED_WATCH_LIMIT,
    }),
  };
});

process.env.SESSION_SECRET = "test-session-secret-for-watch-limit-status";
// Unset, watch creation stops at `not_configured` (501) before the plan floor is read.
process.env.DASHBOARD_AGENT_SECRET_KEY = "test-dashboard-agent-secret";

const { action } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");

let agentDbClient: DashboardAgentDbClient | undefined;

async function seed(prisma: PrismaClient) {
  const slug = `limit_status_${Math.random().toString(36).slice(2, 10)}`;
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

// error_recurrence resolves its target with no run/queue read, so the plan floor is the only
// thing standing between a valid submit and a created watch.
const DRAFT = JSON.stringify({
  spec: {
    kind: "error_recurrence",
    fingerprint: "a1b2c3",
    checkEveryMinutes: 5,
    maxHours: 2,
    note: "ping me if it happens again",
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

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
});

describe("the watch card submit's status for a plan-limit refusal", () => {
  postgresTest(
    "answers 409, not 500, when the window is longer than the plan allows",
    async ({ prisma, postgresContainer }) => {
      ctx.prisma = prisma;
      await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
      agentDbClient = createDashboardAgentDb(postgresContainer.getConnectionUri(), { max: 4 });
      ctx.agentDb = agentDbClient.db;

      const seeded = await seed(prisma);

      const response = await submitRequest(seeded.organization.slug, {
        intent: "watch-create",
        draft: DRAFT,
        clientRequestId: "wreq_limit_1",
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "watch_limit_reached" });
    },
    30_000
  );
});
