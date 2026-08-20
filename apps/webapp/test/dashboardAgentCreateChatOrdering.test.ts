import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChat: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
  mintUserActorToken: vi.fn(),
  mintPublicToken: vi.fn(),
  headStart: vi.fn(),
  startSession: vi.fn(),
  softDeleteChat: vi.fn(),
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  // Mutable so a test can take the head start away and drive the cold path.
  env: { SESSION_SECRET: "test-session-secret", ANTHROPIC_API_KEY: "sk-test" } as Record<
    string,
    string | undefined
  >,
}));

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
vi.mock("~/env.server", () => ({ env: mocks.env }));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "usr_real", admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({
    id: "proj_real",
    organizationId: "org_real",
    externalRef: "proj_ref_real",
  }),
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: mocks.findEnvironmentBySlug,
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  isDashboardAgentConfigured: () => true,
  mintDashboardAgentToken: mocks.mintPublicToken,
  mintDashboardAgentUserActorToken: mocks.mintUserActorToken,
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: mocks.startSession,
  dashboardAgentWakeFeedCounter: { inc: vi.fn() },
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: mocks.headStart,
}));
// The chat route reaches the ClickHouse factory through the watch services, and the factory
// builds its client at import time from an env var no test sets.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUri.server", () => ({ resolveTriggerUri: () => null }));
// Spread the real module so this doesn't have to track every query the route imports.
vi.mock("@internal/dashboard-agent-db", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  createChat: mocks.createChat,
  softDeleteChat: mocks.softDeleteChat,
}));
vi.mock("~/services/logger.server", () => ({ logger: mocks.logger }));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

function createChatRequest(clientData?: Record<string, unknown>) {
  const form = new URLSearchParams({
    intent: "create",
    message: JSON.stringify({ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }),
    ...(clientData ? { clientData: JSON.stringify(clientData) } : {}),
  });

  return action({
    request: new Request(
      "https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent",
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: form.toString(),
      }
    ),
    params: { organizationSlug: "acme", projectParam: "api", envParam: "dev" },
    context: {},
  } as any);
}

describe("dashboard agent chat creation — nothing fallible after the row exists", () => {
  beforeEach(() => {
    mocks.createChat.mockReset().mockResolvedValue(undefined);
    mocks.headStart.mockReset().mockResolvedValue(undefined);
    mocks.findEnvironmentBySlug
      .mockReset()
      .mockResolvedValue({ id: "env_real", type: "DEVELOPMENT" });
    mocks.mintUserActorToken.mockReset().mockResolvedValue("tr_uat_real");
    mocks.mintPublicToken.mockReset().mockResolvedValue("pat_public");
    mocks.startSession.mockReset().mockResolvedValue(undefined);
    mocks.softDeleteChat.mockReset().mockResolvedValue({ deleted: true, cancelledWatches: [] });
    mocks.env.ANTHROPIC_API_KEY = "sk-test";
  });

  it("creates no chat when the environment slug resolves to nothing", async () => {
    mocks.findEnvironmentBySlug.mockResolvedValue(null);

    const response = await createChatRequest();

    expect(response.status).toBe(404);
    expect(mocks.createChat).not.toHaveBeenCalled();
  });

  it("creates no chat when the delegated token mint fails", async () => {
    mocks.mintUserActorToken.mockRejectedValue(new Error("signing key unavailable"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    expect(mocks.createChat).not.toHaveBeenCalled();
  });

  it("still creates the chat and head-starts it on the happy path", async () => {
    const response = await createChatRequest();

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ headStarted: true });
    expect(mocks.createChat).toHaveBeenCalledTimes(1);
    expect(mocks.headStart).toHaveBeenCalledTimes(1);
    expect(mocks.headStart.mock.calls[0][0].metadata).toMatchObject({
      userActorToken: "tr_uat_real",
      environmentId: "env_real",
      environmentName: "dev",
    });
    expect(mocks.softDeleteChat).not.toHaveBeenCalled();
  });

  // The head-start metadata is built from the client's clientData: a smuggled
  // `repoSnapshot.tarballUrl` would be fetched and extracted on the agent worker, so only
  // the whitelisted page context may survive the merge.
  it("strips server-owned fields from the clientData before head-starting", async () => {
    const response = await createChatRequest({
      currentPage: "/runs",
      pageContext: { kind: "runs" },
      organizationId: "org_evil",
      userId: "usr_evil",
      projectId: "proj_evil",
      environmentId: "env_evil",
      userActorToken: "tr_uat_evil",
      apiOrigin: "https://evil.example.com",
      repoSnapshot: { tarballUrl: "https://evil.example.com/x.tar.gz" },
      somethingNew: "smuggled",
    });

    expect(response.status).toBe(200);
    const metadata = mocks.headStart.mock.calls[0][0].metadata;
    expect(metadata.currentPage).toBe("/runs");
    expect(metadata.pageContext).toEqual({ kind: "runs" });
    expect(metadata.organizationId).toBe("org_real");
    expect(metadata.userId).toBe("usr_real");
    expect(metadata.projectId).toBe("proj_real");
    expect(metadata.environmentId).toBe("env_real");
    expect(metadata.userActorToken).toBe("tr_uat_real");
    expect(metadata.apiOrigin).toBe("https://api.trigger.dev");
    expect(metadata.repoSnapshot).toBeUndefined();
    expect(metadata).not.toHaveProperty("somethingNew");

    // The chat row's stored context is whitelisted too. createChat(db, params) takes
    // the db as arg 0, so the params object (carrying metadata) is arg 1.
    const chatMetadata = mocks.createChat.mock.calls[0][1].metadata;
    expect(chatMetadata).toEqual({
      context: { currentPage: "/runs", pageContext: { kind: "runs" } },
    });
  });
});

// A failed start means no handover was dispatched and no message was sent, so any session it
// did create idles out having done nothing — the chat row is safe to take back. Once the start
// has resolved the session is live, and removing the chat would hide a running agent.
describe("dashboard agent chat creation — a start that fails part way", () => {
  beforeEach(() => {
    mocks.createChat.mockReset().mockResolvedValue(undefined);
    mocks.headStart.mockReset().mockResolvedValue(undefined);
    mocks.findEnvironmentBySlug
      .mockReset()
      .mockResolvedValue({ id: "env_real", type: "DEVELOPMENT" });
    mocks.mintUserActorToken.mockReset().mockResolvedValue("tr_uat_real");
    mocks.mintPublicToken.mockReset().mockResolvedValue("pat_public");
    mocks.startSession.mockReset().mockResolvedValue(undefined);
    mocks.softDeleteChat.mockReset().mockResolvedValue({ deleted: true, cancelledWatches: [] });
    mocks.env.ANTHROPIC_API_KEY = "sk-test";
    mocks.logger.error.mockReset();
  });

  it("takes the chat back when the head start fails", async () => {
    mocks.headStart.mockRejectedValue(new Error("session create failed"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    expect(mocks.createChat).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteChat).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteChat.mock.calls[0][1]).toMatchObject({
      chatId: mocks.createChat.mock.calls[0][1].id,
      userId: "usr_real",
    });
  });

  it("takes the chat back when the cold start fails", async () => {
    mocks.env.ANTHROPIC_API_KEY = undefined;
    mocks.startSession.mockRejectedValue(new Error("session create failed"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    expect(mocks.createChat).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteChat).toHaveBeenCalledTimes(1);
  });

  it("keeps the chat when the session is live and only its access token failed", async () => {
    mocks.mintPublicToken.mockRejectedValue(new Error("token mint failed"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    expect(mocks.headStart).toHaveBeenCalledTimes(1);
    expect(mocks.createChat).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteChat).not.toHaveBeenCalled();
  });

  it("keeps the chat when a cold-started session's access token failed", async () => {
    mocks.env.ANTHROPIC_API_KEY = undefined;
    mocks.mintPublicToken.mockRejectedValue(new Error("token mint failed"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
    expect(mocks.softDeleteChat).not.toHaveBeenCalled();
  });

  it("surfaces the start's own failure when taking the chat back also fails", async () => {
    mocks.headStart.mockRejectedValue(new Error("session create failed"));
    mocks.softDeleteChat.mockRejectedValue(new Error("chat store unavailable"));

    const response = await createChatRequest();

    expect(response.status).toBe(500);
    const logged = mocks.logger.error.mock.calls.map((call: any[]) => call[1]?.error?.message);
    expect(logged).toContain("session create failed");
  });
});
