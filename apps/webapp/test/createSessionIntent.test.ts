import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import {
  createDashboardAgentDb,
  getChatMessages,
  listChats,
  type DashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import {
  applyDashboardAgentMigrations,
  type MigrationExecutor,
} from "@internal/dashboard-agent-db/testing";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let container: StartedPostgreSqlContainer;
let client: DashboardAgentDbClient;
let db: DashboardAgentDb;

const AUTH = vi.hoisted(() => ({
  id: "user_cs",
  admin: false,
  isImpersonating: false,
}));
const dbHolder = vi.hoisted(() => ({ db: undefined as any }));
const configured = vi.hoisted(() => ({ value: true }));

vi.mock("~/services/session.server", () => ({
  requireUser: () => AUTH,
  requireUserId: () => AUTH.userId,
}));

vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));

vi.mock("~/db.server", () => {
  const findFirst = vi.fn(async () => ({
    id: "proj_1",
    organizationId: "org_1",
    externalRef: "proj_ref",
    organization: { featureFlags: {} },
  }));
  return {
    prisma: new Proxy({}, { get: () => ({ findFirst }) }),
    $replica: new Proxy({}, { get: () => ({ findFirst }) }),
  };
});

vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return dbHolder.db;
  },
}));

vi.mock("~/services/dashboardAgent.server", () => ({
  isDashboardAgentConfigured: () => configured.value,
  dashboardAgentConfig: () => (configured.value ? {} : null),
  dashboardAgentProvider: () => "anthropic",
  dashboardAgentTriggerConfig: () => ({}),
  mintDashboardAgentToken: async () => "tok_test",
  mintDashboardAgentUserActorToken: async () => "uat_test",
  dashboardAgentUserApiOrigin: () => "http://localhost",
  dashboardAgentEnvironmentAddress: () => ({}),
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentHeadStart: async () => {},
  startDashboardAgentSession: async () => {},
}));

vi.mock("~/v3/canUseDashboardAgentWatches.server", () => ({
  canUseDashboardAgentWatches: async () => false,
}));

const loggedErrors = vi.hoisted(() => ({ list: [] as any[] }));
vi.mock("~/services/logger.server", () => ({
  logger: {
    error: (...args: any[]) => loggedErrors.list.push(args),
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "proj_1",
    organizationId: "org_1",
    externalRef: "proj_ref",
    organization: { featureFlags: {} },
  }),
}));

vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION" }),
}));

vi.mock("~/services/dashboardAgentMessageQuota.server", () => ({
  resolveAgentMessageQuota: async () => null,
  recordAgentMessageSent: async () => {},
  MESSAGE_QUOTA_REACHED_ERROR: "quota reached",
}));

vi.mock("~/v3/featureFlags.server", () => ({
  makeFlag: () => async () => false,
}));

vi.mock("~/env.server", () => ({
  env: new Proxy(
    {
      ANTHROPIC_API_KEY: "sk-test",
      ALLOW_INSECURE_DEFAULT_SECRETS: false,
      DASHBOARD_AGENT_SECRET_KEY: "secret",
      CLICKHOUSE_URL: "http://localhost:8123",
    },
    { get: (t, p) => (p in t ? (t as any)[p] : undefined) }
  ),
}));

vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseInstance: undefined,
}));

beforeAll(async () => {
  container = await new PostgreSqlContainer("docker.io/postgres:14").start();
  client = createDashboardAgentDb(container.getConnectionUri());
  db = client.db;
  dbHolder.db = db;
  const execute: MigrationExecutor = (statement) => client.sql.unsafe(statement).then(() => {});
  await applyDashboardAgentMigrations(execute);
}, 120_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

function makeRequest(intent: string, extra?: Record<string, string>): Request {
  const body = new FormData();
  body.set("intent", intent);
  for (const [k, v] of Object.entries(extra ?? {})) body.set(k, v);
  return new Request("http://localhost/resources/orgs/org/projects/proj/env/prod/dashboard-agent", {
    method: "POST",
    body,
  });
}

describe("create-session intent", () => {
  it("returns chatId without publicAccessToken, chat row holds only the opening message", async () => {
    const { action } =
      await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");
    const params = {
      organizationSlug: "org",
      projectParam: "proj",
      envParam: "prod",
    };
    const resp = await action({
      request: makeRequest("create-session"),
      params,
      context: {} as any,
    });
    const data = await resp.json();
    expect(resp.status).toBe(200);
    expect(data.chatId).toBeDefined();
    expect(data.publicAccessToken).toBeUndefined();
    expect(data.headStarted).toBe(false);

    const chatList = await listChats(db, {
      organizationId: "org_1",
      userId: AUTH.id,
    });
    const found = chatList.find((c) => c.id === data.chatId);
    expect(found).toBeDefined();

    const messages = await getChatMessages(db, {
      chatId: data.chatId,
      userId: AUTH.id,
      organizationId: "org_1",
    });
    expect(messages).toEqual([
      {
        id: `alert_creation:opening:${data.chatId}`,
        role: "user",
        parts: [{ type: "text", text: "Create a new alert" }],
      },
    ]);
  });

  it("returns 501 when agent is not configured", async () => {
    configured.value = false;
    const { action } =
      await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent");
    const params = {
      organizationSlug: "org",
      projectParam: "proj",
      envParam: "prod",
    };
    const resp = await action({
      request: makeRequest("create-session"),
      params,
      context: {} as any,
    });
    expect(resp.status).toBe(501);
    configured.value = true;
  });
});
