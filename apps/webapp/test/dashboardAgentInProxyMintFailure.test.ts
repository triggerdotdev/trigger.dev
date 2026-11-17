import { buildJwtAbility } from "@trigger.dev/rbac";
import { generateJWT } from "@trigger.dev/core/v3/jwt";
import { decodeJwt } from "jose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetch: vi.fn(),
  mint: vi.fn(),
  appendMint: vi.fn(),
}));

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));
vi.mock("~/env.server", () => ({
  env: {
    SESSION_SECRET: "test-session-secret",
    DASHBOARD_AGENT_SECRET_KEY: "tr_dev_agent_secret",
    DASHBOARD_AGENT_BASE_URL: "https://api.trigger.dev",
  },
}));
vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));
vi.mock("@internal/dashboard-agent-db", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  chatExists: async () => true,
  getChatScope: async () => ({ kind: null, metadata: {} }),
}));
vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "usr_real", admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/v3/canUseAlertsList.server", () => ({
  canUseAlertsList: async () => false,
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
  findEnvironmentBySlug: async () => ({ id: "env_real", type: "DEVELOPMENT" }),
}));
vi.mock("~/services/dashboardAgent.server", async (importOriginal) => ({
  ...((await importOriginal()) as Record<string, unknown>),
  dashboardAgentApiOrigin: () => "https://api.trigger.dev",
  dashboardAgentUserApiOrigin: () => "https://api.trigger.dev",
  mintDashboardAgentAppendToken: mocks.appendMint,
  mintDashboardAgentUserActorToken: mocks.mint,
  resolveDashboardAgentRepoSnapshot: async () => null,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

import { mintDashboardAgentToken } from "~/services/dashboardAgent.server";
import { action } from "~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$";

function post(body: string, headers: Record<string, string> = {}) {
  const request = new Request(
    "https://app.trigger.dev/resources/orgs/acme/projects/api/env/dev/dashboard-agent/in/realtime/v1/sessions/chat_1/in/append",
    { method: "POST", headers: { "content-type": "application/json", ...headers }, body }
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
    mocks.appendMint.mockReset();
    mocks.appendMint.mockResolvedValue("pat_append");
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

describe("dashboard agent `in` proxy — who may append to the session", () => {
  beforeEach(async () => {
    const actual = await vi.importActual<{
      mintDashboardAgentAppendToken: (chatId: string) => Promise<string>;
    }>("~/services/dashboardAgent.server");
    mocks.fetch.mockReset();
    mocks.fetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (String(url).endsWith("/api/v1/auth/public-tokens")) {
        const body = JSON.parse(String(init?.body));
        return Response.json({
          token: await generateJWT({
            secretKey: "tr_dev_agent_secret",
            payload: { sub: "env_agent", pub: true, scopes: body.scopes },
            expirationTime: body.expirationTime,
          }),
        });
      }
      return Response.json({ ok: true });
    });
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.mint.mockReset();
    mocks.mint.mockResolvedValue("tr_uat_real");
    mocks.appendMint.mockReset();
    mocks.appendMint.mockImplementation(actual.mintDashboardAgentAppendToken);
  });

  // Catches: the browser's session token carrying write, so it can append to `.in` past the proxy.
  it("mints the browser a token that reads `.out` but cannot write the session", async () => {
    const ability = buildJwtAbility(
      decodeJwt(await mintDashboardAgentToken("chat_1")).scopes as string[]
    );

    expect(ability.can("read", { type: "sessions", id: "chat_1:out" })).toBe(true);
    expect(ability.can("write", { type: "sessions", id: "chat_1" })).toBe(false);
  });

  // Catches: the proxy forwarding the browser's Authorization upstream instead of its own token.
  it("signs the upstream append with its own write token, never the browser's", async () => {
    const response = await post(messageBody, { authorization: "Bearer browser_token" });

    expect(response.status).toBe(200);
    const append = mocks.fetch.mock.calls.find(([url]) => String(url).endsWith("/in/append"));
    const authorization = new Headers(append?.[1].headers).get("authorization") ?? "";
    expect(authorization).not.toBe("Bearer browser_token");
    const ability = buildJwtAbility(
      decodeJwt(authorization.replace(/^Bearer /, "")).scopes as string[]
    );
    expect(ability.can("write", { type: "sessions", id: "chat_1" })).toBe(true);
  });
});
