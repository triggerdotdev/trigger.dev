import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  mint: vi.fn(),
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
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  mintDashboardAgentUserActorToken: mocks.mint,
  resolveDashboardAgentRepoSnapshot: async () => null,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

function post(body: string) {
  const request = new Request(
    "https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent/in/realtime/v1/sessions/chat_1/in/append",
    { method: "POST", headers: { "content-type": "application/json" }, body }
  );

  return action({
    request,
    params: {
      organizationSlug: "acme",
      projectParam: "api",
      envParam: "dev",
      "*": "realtime/v1/sessions/chat_1/in/append",
    },
    context: {},
  } as any);
}

const messageBody = JSON.stringify({
  kind: "message",
  payload: { message: { parts: [{ type: "text", text: "hi" }] } },
});

describe("dashboard agent `in` proxy — a failed mint", () => {
  beforeEach(() => {
    mocks.fetch.mockReset();
    mocks.fetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.mint.mockReset();
    mocks.mint.mockResolvedValue("tr_uat_real");
  });

  it("refuses the turn instead of forwarding it with no credential", async () => {
    mocks.mint.mockRejectedValue(new Error("signing key unavailable"));

    const response = await post(messageBody);

    expect(response.status).toBe(500);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("still forwards a non-JSON body unchanged", async () => {
    const response = await post("not json at all");

    expect(response.status).toBe(200);
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.fetch.mock.calls[0][1].body).toBe("not json at all");
  });

  it("forwards the minted token when the mint succeeds", async () => {
    const response = await post(messageBody);

    expect(response.status).toBe(200);
    const forwarded = JSON.parse(mocks.fetch.mock.calls[0][1].body as string);
    expect(forwarded.payload.metadata.userActorToken).toBe("tr_uat_real");
  });
});
