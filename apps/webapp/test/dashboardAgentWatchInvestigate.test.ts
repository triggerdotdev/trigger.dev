import { describe, expect, it, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  claims: { watchId: "watch_1" } as undefined | { watchId: string },
  watch: undefined as any,
  authorized: true,
  appends: [] as Array<{ sessionId: string; io: string; body: any }>,
  appendThrows: false,
}));

vi.mock("~/env.server", () => ({
  env: { DASHBOARD_AGENT_SECRET_KEY: "tr_dashboard_agent", APP_ORIGIN: "https://app.example.com" },
}));

vi.mock("~/services/logger.server", () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
}));

vi.mock("~/services/dashboardAgentDb.server", () => ({ dashboardAgentDb: {} }));

vi.mock("@internal/dashboard-agent-db", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  getWatch: async () => ctx.watch,
}));

vi.mock("~/services/dashboardAgentWatchToken.server", () => ({
  bearerToken: (request: Request) =>
    request.headers.get("authorization")?.replace(/^Bearer /, "") ?? undefined,
  verifyWatchTokenFromRequest: async () => ctx.claims,
}));

vi.mock("~/services/dashboardAgentWatches.server", () => ({
  authorizeWatchEnvironment: async () =>
    ctx.authorized
      ? {
          ok: true,
          environment: {
            id: "env_1",
            type: "PRODUCTION",
            project: { id: "project_1", externalRef: "proj_from_env" },
          },
        }
      : { ok: false, reason: "access_revoked" },
}));

const mints = vi.hoisted(() => [] as Array<{ userId: string; environmentId?: string }>);
vi.mock("~/services/dashboardAgent.server", () => ({
  dashboardAgentApiOrigin: () => "https://api.example.com",
  dashboardAgentUserApiOrigin: () => "https://api.example.com",
  dashboardAgentEnvironmentName: (type: string | undefined) =>
    type === "PRODUCTION" ? "prod" : undefined,
  mintDashboardAgentUserActorToken: async (
    userId: string,
    opts: { environmentId?: string } = {}
  ) => {
    mints.push({ userId, environmentId: opts.environmentId });
    return `uat_for_${userId}`;
  },
  resolveDashboardAgentRepoSnapshot: async () => null,
}));

vi.mock("@trigger.dev/core/v3", async (importOriginal) => ({
  ...((await importOriginal()) as any),
  ApiClient: class {
    constructor(
      public baseUrl: string,
      public accessToken: string
    ) {}
    async appendToSessionStream(sessionId: string, io: string, body: string) {
      if (ctx.appendThrows) throw new Error("session not found");
      ctx.appends.push({ sessionId, io, body: JSON.parse(body) });
      return { ok: true };
    }
  },
}));

vi.mock("~/services/session.server", () => ({
  requireUser: async () => ({ id: "user_1", admin: false, isImpersonating: false }),
}));
vi.mock("~/v3/canAccessDashboardAgent.server", () => ({
  canAccessDashboardAgent: async () => true,
}));
vi.mock("~/models/project.server", () => ({
  findProjectBySlug: async () => ({ id: "project_1", externalRef: "proj_1" }),
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {},
  sqlDatabaseSchema: undefined,
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  findEnvironmentBySlug: async () => ({ id: "env_1", type: "PRODUCTION" }),
}));

const { action } = await import("~/routes/api.v1.dashboard-agent.watches.$watchId.investigate");
const { action: inProxyAction } =
  await import("~/routes/resources.orgs.$organizationSlug.projects.$projectParam.env.$envParam.dashboard-agent.in.$");

function watchRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "watch_1",
    chatId: "chat_1",
    identity: "run_finished:run_a1",
    spec: {
      kind: "run_finished",
      runId: "run_a1",
      checkEveryMinutes: 5,
      maxHours: 2,
      note: "tell me when the receipt run finishes",
    },
    status: "fired",
    deliveryStatus: "delivered",
    resolution: "condition_met",
    observedOutcome: {
      kind: "run_finished",
      verified: true,
      finalStatus: "COMPLETED_WITH_ERRORS",
      durationMs: 4200,
    },
    investigateOnAttention: true,
    organizationId: "org_1",
    projectId: "project_1",
    projectRef: "proj_1",
    environmentId: "env_1",
    userId: "user_1",
    lastResult: { outcome: "COMPLETED_WITH_ERRORS", durationMs: 4200 },
    firedAt: new Date("2026-01-01T12:00:00.000Z"),
    ...overrides,
  };
}

function post(watchId = "watch_1") {
  return action({
    request: new Request(
      `https://app.example.com/api/v1/dashboard-agent/watches/${watchId}/investigate`,
      { method: "POST", headers: { Authorization: "Bearer watch_token" }, body: "{}" }
    ),
    params: { watchId },
    context: {} as never,
  } as never) as Promise<Response>;
}

beforeEach(() => {
  ctx.claims = { watchId: "watch_1" };
  ctx.watch = watchRow();
  ctx.authorized = true;
  ctx.appends = [];
  ctx.appendThrows = false;
  mints.length = 0;
});

describe("POST /api/v1/dashboard-agent/watches/:watchId/investigate", () => {
  it("sends the investigate action with a token minted for the watch's own user and environment", async () => {
    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, investigating: true });

    expect(ctx.appends).toHaveLength(1);
    const append = ctx.appends[0]!;
    expect(append.sessionId).toBe("chat_1");
    expect(append.io).toBe("in");
    expect(append.body.payload.trigger).toBe("action");
    expect(append.body.payload.action).toMatchObject({
      type: "watch.investigate",
      // Stable per (watch, outcome), so a retried kick is a no-op on the agent side.
      id: "watch:watch_1:fired:investigate",
      watchId: "watch_1",
      identity: "run_finished:run_a1",
      resolution: "condition_met",
      note: "tell me when the receipt run finishes",
    });
    expect(append.body.payload.action.observed.finalStatus).toBe("COMPLETED_WITH_ERRORS");

    expect(append.body.payload.metadata).toMatchObject({
      userId: "user_1",
      organizationId: "org_1",
      projectId: "project_1",
      projectRef: "proj_1",
      environmentId: "env_1",
      environmentName: "prod",
      userActorToken: "uat_for_user_1",
    });
    // Minted for the row's user and the row's environment, never anything a request body names.
    expect(mints).toEqual([{ userId: "user_1", environmentId: "env_1" }]);
  });

  it("investigates an attention outcome that expired, not just a fired one", async () => {
    ctx.watch = watchRow({
      spec: {
        kind: "backlog_drain",
        queue: "task/send-receipt",
        checkEveryMinutes: 5,
        maxHours: 2,
      },
      identity: "backlog_drain:task/send-receipt",
      status: "expired",
      resolution: "window_completed",
      observedOutcome: { kind: "backlog_drain", verified: true, depth: 412 },
    });

    const res = await post();

    expect(await res.json()).toEqual({ ok: true, investigating: true });
    expect(ctx.appends[0]!.body.payload.action.id).toBe("watch:watch_1:expired:investigate");
  });

  it("starts nothing on a positive outcome, consent or not", async () => {
    ctx.watch = watchRow({
      observedOutcome: {
        kind: "run_finished",
        verified: true,
        finalStatus: "COMPLETED_SUCCESSFULLY",
      },
    });

    const res = await post();

    expect(await res.json()).toEqual({ ok: true, investigating: false });
    expect(ctx.appends).toHaveLength(0);
    expect(mints).toHaveLength(0);
  });

  it("starts nothing without the consent", async () => {
    ctx.watch = watchRow({ investigateOnAttention: false });

    const res = await post();

    expect(await res.json()).toEqual({ ok: true, investigating: false });
    expect(ctx.appends).toHaveLength(0);
  });

  it("refuses a watch that hasn't resolved", async () => {
    ctx.watch = watchRow({ status: "active", resolution: null, deliveryStatus: "not_required" });

    const res = await post();

    expect(res.status).toBe(409);
    expect((await res.json()).code).toBe("not_resolved");
    expect(ctx.appends).toHaveLength(0);
  });

  it("mints nothing once access has been revoked", async () => {
    ctx.authorized = false;

    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("access_revoked");
    expect(mints).toHaveLength(0);
    expect(ctx.appends).toHaveLength(0);
  });

  it("rejects a token minted for another watch", async () => {
    ctx.claims = { watchId: "watch_other" };

    const res = await post();

    expect(res.status).toBe(403);
    expect((await res.json()).code).toBe("watch_mismatch");
    expect(ctx.appends).toHaveLength(0);
  });

  it("401s without a valid watch token", async () => {
    ctx.claims = undefined;

    const res = await post();

    expect(res.status).toBe(401);
    expect(ctx.appends).toHaveLength(0);
  });

  it("404s when the row is gone", async () => {
    ctx.watch = null;

    const res = await post();

    expect(res.status).toBe(404);
  });

  it("does not fail when the kick itself fails", async () => {
    ctx.appendThrows = true;

    const res = await post();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, investigating: false, code: "kick_failed" });
  });
});

describe("the dashboard-agent in proxy", () => {
  const upstream = vi.fn(async () => new Response("{}", { status: 200 }));

  function append(payload: Record<string, unknown>) {
    return inProxyAction({
      request: new Request(
        "https://app.example.com/resources/orgs/acme/projects/checkout/env/prod/dashboard-agent/in/realtime/v1/sessions/chat_1/in/append",
        { method: "POST", body: JSON.stringify({ kind: "message", payload }) }
      ),
      params: {
        organizationSlug: "acme",
        projectParam: "checkout",
        envParam: "prod",
        "*": "realtime/v1/sessions/chat_1/in/append",
      },
      context: {} as never,
    } as never) as Promise<Response>;
  }

  beforeEach(() => {
    upstream.mockClear();
    vi.stubGlobal("fetch", upstream);
  });

  it("refuses a browser-supplied action, forwarding nothing and minting nothing", async () => {
    const res = await append({
      chatId: "chat_1",
      trigger: "action",
      action: { type: "watch.investigate", id: "forged", watchId: "watch_1", spec: { kind: "x" } },
    });

    expect(res.status).toBe(403);
    expect(upstream).not.toHaveBeenCalled();
    expect(mints).toHaveLength(0);
  });

  it("still forwards a normal turn, with the token injected", async () => {
    const res = await append({ chatId: "chat_1", trigger: "submit-message" });

    expect(res.status).toBe(200);
    expect(upstream).toHaveBeenCalledTimes(1);
    const body = JSON.parse((upstream.mock.calls[0]![1] as RequestInit).body as string);
    expect(body.payload.metadata.userActorToken).toBe("uat_for_user_1");
    expect(mints).toEqual([{ userId: "user_1", environmentId: "env_1" }]);
  });
});
