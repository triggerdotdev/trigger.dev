import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import {
  createChat,
  createDashboardAgentDb,
  type DashboardAgentDbClient,
} from "@internal/dashboard-agent-db";
import {
  applyDashboardAgentMigrations,
  type MigrationExecutor,
} from "@internal/dashboard-agent-db/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), db: undefined as any }));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "usr_real", admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/v3/canUseDashboardAgentWatches.server", () => ({
  canUseDashboardAgentWatches: async () => false,
}));
vi.mock("~/models/project.server", () => ({
  findProjectWithOrgFlagsBySlug: async () => ({
    id: "proj_real",
    organizationId: "org_real",
    externalRef: "proj_ref_real",
    organization: { featureFlags: {} },
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_real", type: "DEVELOPMENT", branchName: null }),
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  mintDashboardAgentUserActorToken: async () => "tr_uat_real",
  resolveDashboardAgentRepoSnapshot: async () => null,
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({
  get dashboardAgentDb() {
    return mocks.db;
  },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

const STORED_DRAFT = {
  capabilityKey: "queue.depth",
  answers: { area: "queues", what: "queue.depth", scope: "all", condition: "100" },
};

const CLIENT_DRAFT = {
  capabilityKey: "queue.depth",
  answers: { area: "queues", what: "queue.depth", scope: "all", condition: "250" },
};

let container: StartedPostgreSqlContainer;
let client: DashboardAgentDbClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer("docker.io/postgres:14").start();
  client = createDashboardAgentDb(container.getConnectionUri());
  mocks.db = client.db;
  const execute: MigrationExecutor = (statement) => client.sql.unsafe(statement).then(() => {});
  await applyDashboardAgentMigrations(execute);
  await createChat(client.db, {
    id: "chat_alert",
    organizationId: "org_real",
    userId: "usr_real",
    kind: "alert_creation",
  });
  await createChat(client.db, { id: "chat_plain", organizationId: "org_real", userId: "usr_real" });
  await createChat(client.db, {
    id: "chat_drafted",
    organizationId: "org_real",
    userId: "usr_real",
    kind: "alert_creation",
    metadata: { context: { toolScope: "alert_creation", alertDraft: STORED_DRAFT } },
  });
});

afterAll(async () => {
  await client?.close();
  await container?.stop();
});

async function appendTurn(chatId: string, metadata: Record<string, unknown>) {
  const path = `realtime/v1/sessions/${chatId}/in/append`;
  const response = await action({
    request: new Request(
      `https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent/in/${path}`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          kind: "message",
          payload: { metadata, message: { parts: [{ type: "text", text: "hi" }] } },
        }),
      }
    ),
    params: { organizationSlug: "acme", projectParam: "api", envParam: "dev", "*": path },
    context: {},
  } as any);
  expect(response.status).toBe(200);
  const forwarded = JSON.parse(mocks.fetch.mock.calls.at(-1)![1].body as string);
  return forwarded.payload.metadata as Record<string, unknown>;
}

describe("dashboard agent `in` proxy — chat scope", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(
      async () => new Response(JSON.stringify({ ok: true }), { status: 200 })
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("runs an alert creation chat with its scope when the client sent none", async () => {
    expect(await appendTurn("chat_alert", { currentPage: "/runs" })).toMatchObject({
      toolScope: "alert_creation",
    });
  });

  it("carries the stored draft into a turn that sent no scope", async () => {
    expect(await appendTurn("chat_drafted", { currentPage: "/runs" })).toMatchObject({
      toolScope: "alert_creation",
      alertDraft: STORED_DRAFT,
    });
  });

  it("keeps the client's draft and adds no stored draft when the client sent one", async () => {
    const metadata = await appendTurn("chat_drafted", { alertDraft: CLIENT_DRAFT });
    expect(metadata.toolScope).toBe("alert_creation");
    expect(metadata.alertDraft).toEqual(CLIENT_DRAFT);
  });

  it("uses the client's draft for an alert chat with no stored draft", async () => {
    expect(await appendTurn("chat_alert", { alertDraft: CLIENT_DRAFT })).toMatchObject({
      toolScope: "alert_creation",
      alertDraft: CLIENT_DRAFT,
    });
  });

  it("ignores a scope the client sent for a plain chat", async () => {
    expect(await appendTurn("chat_plain", { toolScope: "alert_creation" })).not.toHaveProperty(
      "toolScope"
    );
  });

  it("adds no scope to a plain chat", async () => {
    expect(await appendTurn("chat_plain", { currentPage: "/runs" })).not.toHaveProperty(
      "toolScope"
    );
  });
});
