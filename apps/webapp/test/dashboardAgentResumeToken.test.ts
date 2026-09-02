/**
 * Resuming a chat replaces the session's stored metadata, so the resume has to mint its own
 * delegated token — a run booting from token-less metadata has no access to anything.
 *
 * Real database and a real mint; only the boundaries this process can't stand up are stubbed
 * (the Trigger API the session start calls, the agent's own datastore, the dashboard session).
 */

import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { expect, vi } from "vitest";

const SESSION_SECRET = "test-session-secret-for-agent-resume";

const ctx = vi.hoisted(() => ({
  prisma: undefined as unknown as PrismaClient,
  userId: "",
  startedClientData: undefined as Record<string, unknown> | undefined,
}));

vi.mock("~/db.server", () => {
  const proxy = new Proxy(
    {},
    { get: (_target, prop) => (ctx.prisma as unknown as Record<string, unknown>)[prop as string] }
  );
  return { prisma: proxy, $replica: proxy, sqlDatabaseSchema: undefined };
});
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret-for-agent-resume",
    ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef",
    APP_ORIGIN: "https://app.example.com",
    DASHBOARD_AGENT_SECRET_KEY: "tr_dev_agent",
    CLICKHOUSE_URL: "http://localhost:8123",
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: ctx.userId, admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: {},
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("@internal/dashboard-agent-db", () => ({ chatExists: async () => true }));
vi.mock("~/services/dashboardAgent.server", async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    isDashboardAgentConfigured: () => true,
    startDashboardAgentSession: async (params: { clientData?: Record<string, unknown> }) => {
      ctx.startedClientData = params.clientData;
      return { publicAccessToken: "pat_public" };
    },
  };
});

const { verifyUserActorToken } = await import("@trigger.dev/rbac");
const { DASHBOARD_AGENT_UAT_CAP } = await import("~/services/dashboardAgent.server");
const { action } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");

function suffix() {
  return Math.random().toString(36).slice(2, 10);
}

async function seed(prisma: PrismaClient) {
  const slug = `resume_${suffix()}`;
  const user = await prisma.user.create({
    data: { email: `${slug}@example.com`, authenticationMethod: "MAGIC_LINK" },
  });
  const organization = await prisma.organization.create({ data: { title: slug, slug } });
  const orgMember = await prisma.orgMember.create({
    data: { organizationId: organization.id, userId: user.id, role: "ADMIN" },
  });
  const project = await prisma.project.create({
    data: { name: slug, slug, organizationId: organization.id, externalRef: `proj_${slug}` },
  });
  const environment = await prisma.runtimeEnvironment.create({
    data: {
      slug: "dev",
      type: "DEVELOPMENT",
      projectId: project.id,
      organizationId: organization.id,
      apiKey: `tr_dev_${slug}`,
      pkApiKey: `pk_dev_${slug}`,
      shortcode: `dev${suffix()}`,
      orgMemberId: orgMember.id,
    },
  });
  return { user, organization, project, environment };
}

async function resume(params: { organizationSlug: string; projectParam: string }) {
  const body = new URLSearchParams({ intent: "start", chatId: "chat_1234" });
  const request = new Request("https://app.example.com/resources/dashboard-agent", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  return action({
    request,
    params: { ...params, envParam: "dev" },
    context: {} as any,
  });
}

postgresTest("resuming a dashboard agent chat mints a delegated token", async ({ prisma }) => {
  ctx.prisma = prisma;
  const { user, organization, project, environment } = await seed(prisma);
  ctx.userId = user.id;

  const response = await resume({
    organizationSlug: organization.slug,
    projectParam: project.slug,
  });
  expect(response.status).toBe(200);

  const first = ctx.startedClientData;
  expect(typeof first?.userActorToken).toBe("string");
  // The token is only usable with the origin and project it is spent against.
  expect(first?.apiOrigin).toBe("https://app.example.com");
  expect(first?.projectRef).toBe(project.externalRef);

  const claims = await verifyUserActorToken(SESSION_SECRET, first!.userActorToken as string);
  expect(claims).toMatchObject({
    userId: user.id,
    client: "dashboard-agent",
    environmentId: environment.id,
    organizationId: organization.id,
    cap: DASHBOARD_AGENT_UAT_CAP,
  });

  // A second resume mints again, with the same scope — never a wider one.
  ctx.startedClientData = undefined;
  await resume({ organizationSlug: organization.slug, projectParam: project.slug });
  const second = await verifyUserActorToken(
    SESSION_SECRET,
    ctx.startedClientData!.userActorToken as string
  );
  expect(second).toMatchObject({
    userId: claims!.userId,
    environmentId: claims!.environmentId,
    organizationId: claims!.organizationId,
    cap: claims!.cap,
  });
});
