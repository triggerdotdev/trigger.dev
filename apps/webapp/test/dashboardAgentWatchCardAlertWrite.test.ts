import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { describe, expect, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  userId: "",
  outcomes: [] as unknown[],
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
vi.mock("~/v3/canUseDashboardAgentWatches.server", () => ({
  canUseDashboardAgentWatches: async () => true,
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateSession: async () => ({
      ok: true,
      ability: {
        can: (action: string, resource: { envType?: string }) =>
          !(action === "write" && resource.envType === "PRODUCTION"),
        canSuper: () => false,
      },
    }),
  },
}));

vi.mock("~/services/dashboardAgentWatches.server", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const { subscribeUserToWatchAlerts } =
    await import("~/services/dashboardAgentWatchAlerts.server");
  type SubscribeParams = Parameters<typeof subscribeUserToWatchAlerts>[0];
  return {
    ...actual,
    submitDashboardAgentWatch: async (
      params: Omit<SubscribeParams, "authorize"> & { authorizeAlerts: SubscribeParams["authorize"] }
    ) => {
      ctx.outcomes.push(
        await subscribeUserToWatchAlerts({
          userId: params.userId,
          environment: params.environment,
          authorize: params.authorizeAlerts,
        })
      );
      return { ok: false, code: "internal", error: "stop" };
    },
  };
});

process.env.SESSION_SECRET = "test-session-secret-for-watch-card-alert-write";
process.env.ALERT_FROM_EMAIL = "alerts@example.com";
process.env.ALERT_EMAIL_TRANSPORT = "smtp";

const { action } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");

async function seed(prisma: PrismaClient) {
  const slug = `card_write_${Math.random().toString(36).slice(2, 10)}`;
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
  return { slug, project };
}

const DRAFT = JSON.stringify({
  spec: {
    kind: "run_start",
    runId: "run_1",
    checkEveryMinutes: 1,
    maxHours: 2,
    note: "tell me when it starts",
  },
  followUp: { investigateOnAttention: false, notifyExternally: true },
});

describe("the watch card's email subscription", () => {
  postgresTest("is refused where the session user can't write alerts", async ({ prisma }) => {
    ctx.prisma = prisma;
    ctx.outcomes = [];
    const { slug, project } = await seed(prisma);

    await action({
      request: new Request(
        `https://app.trigger.dev/resources/orgs/${slug}/projects/${slug}/env/prod/dashboard-agent`,
        {
          method: "POST",
          headers: { "content-type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            intent: "watch-create",
            draft: DRAFT,
            clientRequestId: "wreq_1",
          }).toString(),
        }
      ),
      params: { organizationSlug: slug, projectParam: slug, envParam: "prod" },
      context: {},
    } as never);

    expect(ctx.outcomes).toEqual([{ ok: false, reason: "forbidden" }]);
    expect(await prisma.projectAlertChannel.count({ where: { projectId: project.id } })).toBe(0);
  });
});
