import { buildJwtAbility, signUserActorToken, type UserActorClaims } from "@trigger.dev/rbac";
import { json } from "@remix-run/server-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const SESSION_SECRET = "test-session-secret";

// The environment claim on a user-actor token has to survive the route-builder path: the builder
// authenticates, then a route resolves what the URL targets, and the two must be checked against
// each other. These tests drive a real PAT route end to end with a real signed token.

const mocks = vi.hoisted(() => ({
  authenticateUserActor: vi.fn(),
  authenticatePat: vi.fn(),
  findFirst: vi.fn(),
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: mocks.authenticateUserActor,
    authenticatePat: mocks.authenticatePat,
  },
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: { runtimeEnvironment: { findFirst: mocks.findFirst } },
}));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock("~/services/personalAccessToken.server", async () => {
  const { verifyUserActorToken } = await import("@trigger.dev/rbac");
  return {
    updateLastAccessedAtIfStale: vi.fn(),
    // Mirror production: recover the token's own claims from the bearer when the plugin
    // returned identity only. Test tokens carry no source PAT, so no liveness recheck.
    resolveAndRecheckUserActorClaims: async (claims: unknown, bearer: string) =>
      claims ?? (await verifyUserActorToken("test-session-secret", bearer)),
  };
});
vi.mock("~/services/authTelemetry.server", () => ({
  authenticateBearerWithTelemetry: vi.fn(),
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/tenantContext.server", () => ({
  tenantContext: { enrich: vi.fn() },
  tenantContextFromAuthEnvironment: vi.fn(),
}));
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () => ({
  WorkerGroupTokenService: class {},
}));
vi.mock("~/v3/services/common.server", () => ({
  ServiceValidationError: class extends Error {},
}));
vi.mock("@internal/run-engine", () => ({
  EngineServiceValidationError: class extends Error {},
}));

import { createLoaderPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const USER_ID = "usr_1";
const CLAIMED_ENVIRONMENT_ID = "env_dev";

async function agentToken(
  opts: { environmentId?: string } = { environmentId: CLAIMED_ENVIRONMENT_ID }
) {
  return signUserActorToken(SESSION_SECRET, {
    userId: USER_ID,
    client: "dashboard-agent",
    ...(opts.environmentId ? { environmentId: opts.environmentId } : {}),
    cap: ["read:runs"],
  });
}

/** A route that targets a project, like every PAT route the agent's token can reach. */
function projectRoute(context: () => { projectId?: string; environmentId?: string }) {
  return createLoaderPATApiRoute(
    {
      params: z.object({ projectRef: z.string() }),
      context,
      authorization: { action: "read", resource: () => ({ type: "runs" }) },
    },
    async ({ authentication }) =>
      json({ environmentId: authentication.userActor?.environmentId ?? null })
  );
}

/** A route that declares no context and no authorization, like `api.v1.orgs`'s action. */
function contextlessRoute(options: { identityOnly?: true } = {}) {
  return createLoaderPATApiRoute(options, async ({ authentication }) =>
    json({ environmentId: authentication.userActor?.environmentId ?? null })
  );
}

async function callRoute(
  loader: ReturnType<typeof projectRoute>,
  token: string
): Promise<{ status: number; body: any }> {
  const response = await loader({
    request: new Request("https://api.trigger.dev/api/v1/projects/proj_abc/runs", {
      headers: { Authorization: `Bearer ${token}` },
    }),
    params: { projectRef: "proj_abc" },
    context: {},
  } as any);
  return { status: response.status, body: await response.json() };
}

function controllerResult(claims: UserActorClaims | undefined) {
  return {
    ok: true,
    userId: USER_ID,
    ...(claims ? { claims } : {}),
    subject: { type: "userActor", userId: USER_ID, organizationId: "org_1" },
    ability: buildJwtAbility(["read:runs"]),
  };
}

describe("user-actor environment claim through a PAT route builder", () => {
  beforeEach(() => {
    mocks.authenticateUserActor.mockReset();
    mocks.findFirst.mockReset();
  });

  it("hands the claim to the handler when the URL targets the claimed environment's project", async () => {
    const token = await agentToken();
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({
        userId: USER_ID,
        client: "dashboard-agent",
        environmentId: CLAIMED_ENVIRONMENT_ID,
      })
    );
    mocks.findFirst.mockResolvedValue({ organizationId: "org_1", projectId: "proj_1" });

    const result = await callRoute(
      projectRoute(() => ({ projectId: "proj_1" })),
      token
    );

    expect(result.status).toBe(200);
    expect(result.body.environmentId).toBe(CLAIMED_ENVIRONMENT_ID);
  });

  it("fails closed when the URL targets another project", async () => {
    const token = await agentToken();
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({
        userId: USER_ID,
        client: "dashboard-agent",
        environmentId: CLAIMED_ENVIRONMENT_ID,
      })
    );
    mocks.findFirst.mockResolvedValue({ organizationId: "org_1", projectId: "proj_1" });

    const result = await callRoute(
      projectRoute(() => ({ projectId: "proj_other" })),
      token
    );

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
  });

  it("fails closed when a route names a different environment", async () => {
    const token = await agentToken();
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({
        userId: USER_ID,
        client: "dashboard-agent",
        environmentId: CLAIMED_ENVIRONMENT_ID,
      })
    );

    const result = await callRoute(
      projectRoute(() => ({ projectId: "proj_1", environmentId: "env_prod" })),
      token
    );

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
    // The claim alone answers it — no environment lookup needed.
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("recovers the claim itself when the controller doesn't return it", async () => {
    const token = await agentToken();
    // An RBAC plugin built against an older contract returns identity only.
    mocks.authenticateUserActor.mockImplementation(async () => controllerResult(undefined));
    mocks.findFirst.mockResolvedValue({ organizationId: "org_1", projectId: "proj_1" });

    const result = await callRoute(
      projectRoute(() => ({ projectId: "proj_other" })),
      token
    );

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
  });

  it("refuses a dashboard-agent token that carries no environment claim", async () => {
    const token = await agentToken({});
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({ userId: USER_ID, client: "dashboard-agent" })
    );

    const result = await callRoute(
      projectRoute(() => ({ projectId: "proj_1" })),
      token
    );

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
  });

  it("fails closed on a route that names nothing to check the claim against", async () => {
    const token = await agentToken();
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({
        userId: USER_ID,
        client: "dashboard-agent",
        environmentId: CLAIMED_ENVIRONMENT_ID,
      })
    );

    const result = await callRoute(contextlessRoute(), token);

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
    // Nothing to compare against, so no environment lookup is attempted.
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("admits a claim-bearing token on a route that declares itself identity-only", async () => {
    const token = await agentToken();
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({
        userId: USER_ID,
        client: "dashboard-agent",
        environmentId: CLAIMED_ENVIRONMENT_ID,
      })
    );

    const result = await callRoute(contextlessRoute({ identityOnly: true }), token);

    expect(result.status).toBe(200);
    expect(result.body.environmentId).toBe(CLAIMED_ENVIRONMENT_ID);
  });

  it("still admits a claimless token on a contextless route, as the PAT exchange mints", async () => {
    const token = await signUserActorToken(SESSION_SECRET, {
      userId: USER_ID,
      client: "personal-access-token",
      cap: ["read:runs"],
    });
    mocks.authenticateUserActor.mockImplementation(async () =>
      controllerResult({ userId: USER_ID, client: "personal-access-token" })
    );

    const result = await callRoute(contextlessRoute(), token);

    expect(result.status).toBe(200);
    expect(result.body.environmentId).toBeNull();
  });
});
