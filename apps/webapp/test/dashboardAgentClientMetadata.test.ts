import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
}));

vi.mock("~/db.server", () => ({ $replica: {} }));
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
  findEnvironmentBySlug: async () => ({ id: "env_real", type: "DEVELOPMENT" }),
}));
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentEnvironmentName: () => "dev",
  mintDashboardAgentUserActorToken: async () => "tr_uat_real",
  resolveDashboardAgentRepoSnapshot: async () => null,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

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
    expect(metadata.apiOrigin).toBe("https://api.trigger.dev");
    expect(metadata.userActorToken).toBe("tr_uat_real");
    expect(metadata.repoSnapshot).toBeUndefined();
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
