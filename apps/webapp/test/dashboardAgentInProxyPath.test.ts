import {
  createChat,
  softDeleteChat,
  createDashboardAgentDb,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import { applyDashboardAgentMigrations } from "@internal/dashboard-agent-db/testing";
import { postgresTest } from "@internal/testcontainers";
import type { PrismaClient } from "@trigger.dev/database";
import { afterEach, expect, describe, vi } from "vitest";

const ctx = vi.hoisted(() => ({
  agentDb: undefined as unknown as DashboardAgentDb,
  alertsEnabled: true,
  mintOpts: [] as Array<{ environmentId: string; alertWrites?: unknown }>,
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return ctx.agentDb;
  },
}));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: USER, admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({
  canUseAlertsList: async () => ctx.alertsEnabled,
}));
vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async (_org: string, projectParam: string) => ({
    id: `proj_${projectParam}`,
    organizationId: ORG,
    externalRef: `ref_${projectParam}`,
    organization: { featureFlags: {} },
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async (projectId: string, slug: string) => ({
    id: `env_${projectId}_${slug}`,
    type: slug === "prod" ? "PRODUCTION" : "DEVELOPMENT",
    branchName: null,
  }),
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  isDashboardAgentConfigured: () => true,
  mintDashboardAgentToken: async () => "pat",
  mintDashboardAgentUserActorToken: async (
    _userId: string,
    opts: { environmentId: string; alertWrites?: unknown }
  ) => {
    ctx.mintOpts.push(opts);
    return `uat_${opts.environmentId}`;
  },
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: async () => ({ publicAccessToken: "pat" }),
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: vi.fn(),
}));
vi.mock("~/services/dashboardAgentQuota.server", () => ({
  agentTurnCountsAgainstQuota: () => false,
  recordAgentMessageSent: vi.fn(),
  resolveAgentMessageQuota: async () => null,
}));

const ORG = "org_scope";
const USER = "user_scope";

const { action: agentAction } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");
const { action: inAction } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$");

let agentDbClient: DashboardAgentDbClient | undefined;

async function boot(prisma: PrismaClient, connectionUri: string) {
  await applyDashboardAgentMigrations((statement) => prisma.$executeRawUnsafe(statement));
  agentDbClient = createDashboardAgentDb(connectionUri, { max: 2 });
  ctx.agentDb = agentDbClient.db;
}

afterEach(async () => {
  await agentDbClient?.close();
  agentDbClient = undefined;
  vi.unstubAllGlobals();
});

function params(projectParam: string, envParam = "dev") {
  return { organizationSlug: "acme", projectParam, envParam };
}

function postAgent(projectParam: string, body: Record<string, string>, envParam = "dev") {
  const form = new FormData();
  for (const [key, value] of Object.entries(body)) form.set(key, value);
  return agentAction({
    request: new Request("https://app.trigger.dev/resources", { method: "POST", body: form }),
    params: params(projectParam, envParam),
    context: {},
  } as any);
}

function postTurn(projectParam: string, chatId: string, envParam = "dev") {
  return inAction({
    request: new Request("https://app.trigger.dev/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        payload: { message: { parts: [{ type: "text", text: "hi" }] } },
      }),
    }),
    params: {
      ...params(projectParam, envParam),
      "*": `realtime/v1/sessions/${chatId}/in/append`,
    },
    context: {},
  } as any);
}

function postRawTurn(projectParam: string, splat: string, envParam = "dev") {
  return inAction({
    request: new Request("https://app.trigger.dev/resources", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind: "message", payload: { message: { parts: [] } } }),
    }),
    params: { ...params(projectParam, envParam), "*": splat },
    context: {},
  } as any);
}

async function createChatIn(projectParam: string): Promise<string> {
  const response = await postAgent(projectParam, {
    intent: "create",
    message: JSON.stringify({ id: "msg_1", role: "user", parts: [{ type: "text", text: "hi" }] }),
  });
  const data = (await response.json()) as { chatId?: string };
  expect(data.chatId).toBeDefined();
  return data.chatId!;
}

describe("the dashboard agent in-proxy path", () => {
  postgresTest(
    "sends a turn in the scope of the page it came from, not the chat's first one",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", upstream);

      const chatId = await createChatIn("api");

      const turn = await postTurn("web", chatId);
      expect(turn.status).toBe(200);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `https://api.trigger.dev/realtime/v1/sessions/${chatId}/in/append`
      );

      const sent = JSON.parse(String(upstream.mock.calls[0]?.[1]?.body)) as {
        payload: { metadata: Record<string, unknown> };
      };
      expect(sent.payload.metadata).toMatchObject({
        projectRef: "ref_web",
        environmentId: "env_proj_web_dev",
        userActorToken: "uat_env_proj_web_dev",
      });
    },
    30_000
  );

  postgresTest(
    "asks for the alert write cap only when the turn has alert tools",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response("{}", { status: 200 }))
      );
      const chatId = await createChatIn("api");

      ctx.mintOpts = [];
      expect((await postTurn("api", chatId)).status).toBe(200);
      expect(ctx.mintOpts.at(-1)?.alertWrites).toBeDefined();

      ctx.alertsEnabled = false;
      try {
        expect((await postTurn("api", chatId)).status).toBe(200);
        expect(ctx.mintOpts).toHaveLength(2);
        expect(ctx.mintOpts.at(-1)?.alertWrites).toBeUndefined();
      } finally {
        ctx.alertsEnabled = true;
      }
    },
    30_000
  );

  postgresTest(
    "reports a deleted chat as gone",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());

      await createChat(ctx.agentDb, { id: "chat_gone", organizationId: ORG, userId: USER });
      await softDeleteChat(ctx.agentDb, {
        chatId: "chat_gone",
        userId: USER,
        organizationId: ORG,
      });

      expect((await postTurn("api", "chat_gone")).status).toBe(404);
    },
    30_000
  );

  postgresTest(
    "forwards only the chat it authorized, and refuses every other upstream path",
    async ({ prisma, postgresContainer }) => {
      await boot(prisma, postgresContainer.getConnectionUri());
      const upstream = vi.fn(async () => new Response("{}", { status: 200 }));
      vi.stubGlobal("fetch", upstream);

      const mine = await createChatIn("api");
      const victim = await createChatIn("api");

      expect((await postTurn("api", mine)).status).toBe(200);
      expect(upstream.mock.calls[0]?.[0]).toBe(
        `https://api.trigger.dev/realtime/v1/sessions/${mine}/in/append`
      );

      // The splat arrives decoded, so `%2e%2e` and `%2F` reach the route as `..` and `/` —
      // the shapes `new URL` would have collapsed into another chat's path.
      const refused = [
        `realtime/v1/sessions/${mine}/../${victim}/in/append`,
        `realtime/v1/sessions/${mine}/..%2f${victim}/in/append`,
        `realtime/v1/sessions/${mine}/in/append/`,
        `realtime/v1/sessions/${mine}/in`,
        `realtime/v1/sessions/${mine}/out`,
        `realtime/v1/sessions/./in/append`,
        `realtime/v1/sessions/${mine}/in/append/../../${victim}/in/append`,
      ];
      for (const splat of refused) {
        const response = await postRawTurn("api", splat);
        expect([splat, response.status]).toEqual([splat, 404]);
      }
      expect(upstream).toHaveBeenCalledTimes(1);
    },
    30_000
  );
});
