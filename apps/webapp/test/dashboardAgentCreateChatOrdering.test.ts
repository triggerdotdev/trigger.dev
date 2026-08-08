import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  createChat: vi.fn(),
  findEnvironmentBySlug: vi.fn(),
  mintUserActorToken: vi.fn(),
  headStart: vi.fn(),
}));

vi.mock("~/db.server", () => ({ $replica: {}, prisma: {} }));
vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET: "test-session-secret", ANTHROPIC_API_KEY: "sk-test" },
}));
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
  mintDashboardAgentToken: async () => "pat_public",
  mintDashboardAgentUserActorToken: mocks.mintUserActorToken,
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: async () => {},
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: mocks.headStart,
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUri.server", () => ({ resolveTriggerUri: () => null }));
vi.mock("@internal/dashboard-agent-db", () => ({
  chatExists: vi.fn(),
  countUserMessages: vi.fn(),
  createChat: mocks.createChat,
  getChatMessages: vi.fn(),
  getSession: vi.fn(),
  listChatIdsWithOpenInvestigations: vi.fn(),
  listChats: vi.fn(),
  renameChat: vi.fn(),
  setChatPinned: vi.fn(),
  softDeleteChat: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

function createChatRequest() {
  const form = new URLSearchParams({
    intent: "create",
    message: JSON.stringify({ id: "m1", role: "user", parts: [{ type: "text", text: "hi" }] }),
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
  });

  it("creates no chat when the environment slug resolves to nothing", async () => {
    mocks.findEnvironmentBySlug.mockResolvedValue(null);

    const response = await createChatRequest();

    expect(response.status).toBe(404);
    expect(mocks.createChat).not.toHaveBeenCalled();
  });

  it("creates no chat when the token mint fails", async () => {
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
  });
});
