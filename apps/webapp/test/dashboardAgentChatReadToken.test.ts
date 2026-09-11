import { beforeEach, describe, expect, it, vi } from "vitest";

// Opening a chat from history returns its stored session so the browser can resume the
// stream. The stored token is the agent run's own chat token; the browser must get a token
// minted for it (narrowed to `.out`) and never the stored one.

const mocks = vi.hoisted(() => ({
  getChatMessages: vi.fn<(...args: any[]) => Promise<any>>(),
  getSession: vi.fn<(...args: any[]) => Promise<any>>(),
  configured: true,
  mint: vi.fn<(...args: any[]) => Promise<string>>(),
}));

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
  findEnvironmentBySlug: async () => ({ id: "env_real", type: "DEVELOPMENT", slug: "dev" }),
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  isDashboardAgentConfigured: () => mocks.configured,
  mintDashboardAgentToken: mocks.mint,
  mintDashboardAgentUserActorToken: async () => "tr_uat_real",
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: vi.fn(),
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: vi.fn(),
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUriInOrganization.server", () => ({
  resolveTriggerUrisInOrganization: async () => new Map(),
}));
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("@internal/dashboard-agent-db", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  getChatMessages: mocks.getChatMessages,
  getSession: mocks.getSession,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { loader } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

const params = { organizationSlug: "org", projectParam: "proj", envParam: "dev" };
const storedSession = {
  chatId: "chat_abc",
  publicAccessToken: "pat_agent_run_broad",
  lastEventId: "84",
  runId: "run_abc",
  updatedAt: new Date("2026-09-11T12:00:00Z"),
};

async function readChat() {
  const request = new Request(
    "http://localhost/resources/orgs/org/projects/proj/env/dev/dashboard-agent?chatId=chat_abc"
  );
  const response = await loader({ request, params, context: {} } as any);
  return { status: response.status, body: await response.json() };
}

describe("dashboard agent chat read: session token", () => {
  beforeEach(() => {
    mocks.configured = true;
    mocks.mint.mockReset().mockResolvedValue("pat_minted_for_browser");
    mocks.getChatMessages.mockReset().mockResolvedValue([]);
    mocks.getSession.mockReset().mockResolvedValue(storedSession);
  });

  it("replaces the stored agent token with one minted for the browser", async () => {
    const { status, body } = await readChat();
    expect(status).toBe(200);
    expect(body.session.publicAccessToken).toBe("pat_minted_for_browser");
    expect(body.session.lastEventId).toBe("84");
    expect(JSON.stringify(body)).not.toContain("pat_agent_run_broad");
    expect(mocks.mint).toHaveBeenCalledWith("chat_abc");
  });

  it("returns no session when the mint fails, never the stored token", async () => {
    mocks.mint.mockRejectedValue(new Error("mint down"));
    const { status, body } = await readChat();
    expect(status).toBe(200);
    expect(body.session).toBeNull();
    expect(JSON.stringify(body)).not.toContain("pat_agent_run_broad");
  });

  it("returns no session when the agent is not configured", async () => {
    mocks.configured = false;
    const { body } = await readChat();
    expect(body.session).toBeNull();
    expect(mocks.mint).not.toHaveBeenCalled();
  });

  it("keeps a chat with no stored session as null", async () => {
    mocks.getSession.mockResolvedValue(null);
    const { body } = await readChat();
    expect(body.session).toBeNull();
    expect(mocks.mint).not.toHaveBeenCalled();
  });
});
