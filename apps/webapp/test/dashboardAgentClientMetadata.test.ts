import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  findEnvironmentBySlug: vi.fn<(...args: any[]) => Promise<any>>(),
  startSession: vi.fn<(...args: any[]) => Promise<any>>(),
  chatExists: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
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
  mintDashboardAgentUserActorToken: async () => "tr_uat_real",
  resolveDashboardAgentRepoSnapshot: async () => null,
  startDashboardAgentSession: mocks.startSession,
}));
vi.mock("~/services/dashboardAgentHeadStart.server", () => ({
  startDashboardAgentHeadStart: vi.fn(),
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("~/services/resolveTriggerUri.server", () => ({ resolveTriggerUri: () => null }));
// The chat route reaches the ClickHouse factory through the watch services, and the factory
// builds its client at import time from an env var no test sets.
vi.mock("~/services/clickhouse/clickhouseFactoryInstance.server", () => ({
  clickhouseFactory: { getClickhouseForOrganization: async () => ({}) },
}));
vi.mock("@internal/dashboard-agent-db", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  chatExists: mocks.chatExists,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";
import { action as chatAction } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent";

async function appendTurn(metadata: Record<string, unknown>): Promise<Record<string, unknown>> {
  const request = new Request(
    "https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent/in/realtime/v1/sessions/chat_1/in/append",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        kind: "message",
        payload: { metadata, message: { parts: [{ type: "text", text: "hi" }] } },
      }),
    }
  );

  const response = await action({
    request,
    params: {
      organizationSlug: "acme",
      projectParam: "api",
      envParam: "dev",
      "*": "realtime/v1/sessions/chat_1/in/append",
    },
    context: {},
  } as any);

  expect(response.status).toBe(200);
  expect(mocks.fetch).toHaveBeenCalledTimes(1);
  const forwarded = JSON.parse(mocks.fetch.mock.calls[0][1].body as string);
  return forwarded.payload.metadata as Record<string, unknown>;
}

describe("dashboard agent `in` proxy — client metadata", () => {
  beforeEach(() => {
    mocks.findEnvironmentBySlug.mockReset();
    mocks.findEnvironmentBySlug.mockResolvedValue({
      id: "env_real",
      type: "DEVELOPMENT",
      branchName: null,
    });
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mocks.fetch);
  });

  it("keeps the whitelisted page context", async () => {
    const metadata = await appendTurn({
      currentPage: "/orgs/acme/projects/api/env/dev/runs",
      pageContext: { kind: "runs" },
    });

    expect(metadata.currentPage).toBe("/orgs/acme/projects/api/env/dev/runs");
    expect(metadata.pageContext).toEqual({ kind: "runs" });
  });

  it("ignores a client-sent copy of every server-owned field", async () => {
    const metadata = await appendTurn({
      currentPage: "/runs",
      organizationId: "org_evil",
      userId: "usr_evil",
      projectId: "proj_evil",
      projectRef: "proj_ref_evil",
      environmentId: "env_evil",
      environmentName: "prod",
      environmentBranch: "evil-branch",
      apiOrigin: "https://evil.example.com",
      userActorToken: "tr_uat_evil",
      repoSnapshot: { tarballUrl: "https://evil.example.com/x.tar.gz" },
    });

    expect(metadata.organizationId).toBe("org_real");
    expect(metadata.userId).toBe("usr_real");
    expect(metadata.projectId).toBe("proj_real");
    expect(metadata.projectRef).toBe("proj_ref_real");
    expect(metadata.environmentId).toBe("env_real");
    expect(metadata.environmentName).toBe("dev");
    expect(metadata.environmentBranch).toBeUndefined();
    expect(metadata.apiOrigin).toBe("https://api.trigger.dev");
    expect(metadata.userActorToken).toBe("tr_uat_real");
    expect(metadata.repoSnapshot).toBeUndefined();
  });

  // The whole address the proxy hands the agent, for each of the four environment shapes. The
  // name is shared by a parent and all its branches, so a branch is only addressable when its
  // branch travels with the name.
  it.each([
    ["production", { id: "env_prod", type: "PRODUCTION", branchName: null }, "prod", undefined],
    ["staging", { id: "env_stg", type: "STAGING", branchName: null }, "staging", undefined],
    [
      "a preview branch",
      { id: "env_preview_branch", type: "PREVIEW", branchName: "feat/checkout" },
      "preview",
      "feat/checkout",
    ],
    [
      "a development branch",
      { id: "env_dev_branch", type: "DEVELOPMENT", branchName: "katia/spike" },
      "dev",
      "katia/spike",
    ],
  ])("addresses %s by the environment it resolved", async (_name, env, expectedName, branch) => {
    mocks.findEnvironmentBySlug.mockResolvedValue(env);

    const metadata = await appendTurn({ currentPage: "/runs" });

    expect(metadata.environmentId).toBe(env.id);
    expect(metadata.environmentName).toBe(expectedName);
    expect(metadata.environmentBranch).toBe(branch);
  });

  it("drops any field the server doesn't own", async () => {
    const metadata = await appendTurn({
      currentPage: "/runs",
      evalOptOut: false,
      cap: ["admin"],
      somethingNew: "smuggled",
    });

    expect(metadata).not.toHaveProperty("evalOptOut");
    expect(metadata).not.toHaveProperty("cap");
    expect(metadata).not.toHaveProperty("somethingNew");
  });
});

// `intent=start` resumes an owned chat; the client-supplied clientData is folded into the
// resumed run's payload metadata verbatim, so it goes through the same whitelist as the
// `in` proxy. Otherwise a client could inject `repoSnapshot.tarballUrl` and the agent
// worker would fetch and extract it.
describe("dashboard agent `start` intent — client metadata", () => {
  beforeEach(() => {
    mocks.chatExists.mockReset().mockResolvedValue(true);
    mocks.startSession.mockReset().mockResolvedValue({ publicAccessToken: "pat_public" });
    mocks.findEnvironmentBySlug.mockReset().mockResolvedValue({
      id: "env_real",
      type: "DEVELOPMENT",
      branchName: null,
    });
  });

  async function startChat(clientData: Record<string, unknown>) {
    const form = new URLSearchParams({
      intent: "start",
      chatId: "chat_real",
      clientData: JSON.stringify(clientData),
    });

    const response = await chatAction({
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

    expect(response.status).toBe(200);
    expect(mocks.startSession).toHaveBeenCalledTimes(1);
    return mocks.startSession.mock.calls[0][0].clientData as Record<string, unknown>;
  }

  it("keeps the whitelisted page context", async () => {
    const clientData = await startChat({ currentPage: "/runs", pageContext: { kind: "runs" } });

    expect(clientData).toMatchObject({ currentPage: "/runs", pageContext: { kind: "runs" } });
  });

  it("drops every server-owned field a client sends", async () => {
    const clientData = await startChat({
      currentPage: "/runs",
      organizationId: "org_evil",
      userId: "usr_evil",
      projectId: "proj_evil",
      projectRef: "proj_ref_evil",
      environmentId: "env_evil",
      environmentName: "prod",
      environmentBranch: "evil-branch",
      apiOrigin: "https://evil.example.com",
      userActorToken: "tr_uat_evil",
      repoSnapshot: { tarballUrl: "https://evil.example.com/x.tar.gz" },
      somethingNew: "smuggled",
    });

    expect(clientData).toMatchObject({
      currentPage: "/runs",
      organizationId: "org_real",
      userId: "usr_real",
      projectId: "proj_real",
      environmentId: "env_real",
      environmentName: "dev",
    });
    expect(clientData.projectRef).toBeUndefined();
    expect(clientData.environmentBranch).toBeUndefined();
    expect(clientData.apiOrigin).toBeUndefined();
    expect(clientData.userActorToken).toBeUndefined();
    expect(clientData.repoSnapshot).toBeUndefined();
    expect(clientData).not.toHaveProperty("somethingNew");
  });

  it("re-injects the server-owned identity the resumed run boots with", async () => {
    const clientData = await startChat({
      currentPage: "/runs",
      organizationId: "org_evil",
      userId: "usr_evil",
      projectId: "proj_evil",
      environmentId: "env_evil",
    });

    expect(clientData).toMatchObject({
      currentPage: "/runs",
      organizationId: "org_real",
      userId: "usr_real",
      projectId: "proj_real",
      environmentId: "env_real",
    });
  });
});
