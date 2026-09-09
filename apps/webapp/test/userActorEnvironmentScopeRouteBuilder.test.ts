import {
  buildJwtAbility,
  signUserActorToken,
  verifyUserActorToken,
  type UserActorClaims,
} from "@trigger.dev/rbac";
import { json } from "@remix-run/server-runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import * as webappRouteMocks from "./helpers/webappRouteMocks";

const SESSION_SECRET = "test-session-secret";

// The environment claim on a user-actor token has to survive the route-builder path: the builder
// authenticates, then a route resolves what the URL targets, and the two must be checked against
// each other. These tests drive a real PAT route end to end with a real signed token.

const mocks = vi.hoisted(() => ({
  authenticateUserActor: vi.fn(),
  authenticatePat: vi.fn(),
  findFirst: vi.fn(),
  projectFindFirst: vi.fn(),
  organizationFindFirst: vi.fn(),
}));

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticateUserActor: mocks.authenticateUserActor,
    authenticatePat: mocks.authenticatePat,
  },
}));
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: {
    runtimeEnvironment: { findFirst: mocks.findFirst },
    project: { findFirst: mocks.projectFindFirst },
    organization: { findFirst: mocks.organizationFindFirst },
  },
}));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
vi.mock(
  "~/services/personalAccessToken.server",
  // Mirror production: recover the token's own claims from the bearer when the plugin returned
  // identity only. Test tokens carry no source PAT, so no liveness recheck.
  () =>
    webappRouteMocks.personalAccessTokenMock({
      resolveAndRecheckUserActorClaims: async (claims, bearer) =>
        claims ?? (await verifyUserActorToken("test-session-secret", bearer)),
    })
);
vi.mock("~/services/authTelemetry.server", () => webappRouteMocks.authTelemetryMock());
vi.mock("~/services/logger.server", () => webappRouteMocks.loggerMock());
vi.mock("~/services/tenantContext.server", () => webappRouteMocks.tenantContextMock());
vi.mock("~/v3/services/worker/workerGroupTokenService.server", () =>
  webappRouteMocks.workerGroupTokenServiceMock()
);
vi.mock("~/v3/services/common.server", () => webappRouteMocks.serviceValidationErrorMock());
vi.mock("@internal/run-engine", () => webappRouteMocks.engineServiceValidationErrorMock());

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

function agentClaims(): UserActorClaims {
  return {
    userId: USER_ID,
    client: "dashboard-agent",
    environmentId: CLAIMED_ENVIRONMENT_ID,
  };
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
    // The default caller is a dashboard-agent token with the environment claim; the cases that
    // need another controller answer override this.
    mocks.authenticateUserActor.mockImplementation(async () => controllerResult(agentClaims()));
  });

  it("hands the claim to the handler when the URL targets the claimed environment's project", async () => {
    const token = await agentToken();
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

    const result = await callRoute(contextlessRoute(), token);

    expect(result.status).toBe(403);
    expect(result.body.code).toBe("forbidden_environment");
    // Nothing to compare against, so no environment lookup is attempted.
    expect(mocks.findFirst).not.toHaveBeenCalled();
  });

  it("admits a claim-bearing token on a route that declares itself identity-only", async () => {
    const token = await agentToken();

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

/**
 * The org-scoped opt-in: a token carrying an organization claim reads across that organization's
 * projects on a route that has declared itself org-scoped, and every request rechecks membership.
 * Routes without the flag keep the narrow environment check.
 */
describe("organization-scoped user-actor routes through the PAT route builder", () => {
  const ORGANIZATION_ID = "org_1";

  function orgClaims() {
    return { ...agentClaims(), organizationId: ORGANIZATION_ID };
  }

  function orgToken() {
    return signUserActorToken(SESSION_SECRET, { ...orgClaims(), cap: ["read:runs"] });
  }

  /** The org-scoped variant of `projectRoute`. */
  function orgScopedRoute(
    context: () => { organizationId?: string; projectId?: string; environmentId?: string }
  ) {
    return createLoaderPATApiRoute(
      {
        params: z.object({ projectRef: z.string() }),
        context,
        organizationScoped: true,
        authorization: { action: "read", resource: () => ({ type: "runs" }) },
      },
      async ({ authentication }) =>
        json({ organizationId: authentication.userActor?.organizationId ?? null })
    );
  }

  /** An org-level read that names nothing: scoped to the token's own organization. */
  function orgLevelRoute() {
    return createLoaderPATApiRoute(
      { organizationScoped: "tokenOrganization" },
      async ({ authentication }) =>
        json({ organizationId: authentication.userActor?.organizationId ?? null })
    );
  }

  /** The same route without the explicit opt-in: nothing to check the claim against. */
  function namelessRoute() {
    return createLoaderPATApiRoute({ organizationScoped: true }, async () => json({}));
  }

  beforeEach(() => {
    mocks.authenticateUserActor.mockReset();
    mocks.findFirst.mockReset();
    mocks.projectFindFirst.mockReset();
    mocks.organizationFindFirst.mockReset();
    mocks.organizationFindFirst.mockResolvedValue({ id: ORGANIZATION_ID });
    mocks.authenticateUserActor.mockImplementation(async () => controllerResult(orgClaims()));
  });

  type AuthCase = {
    name: string;
    setup?: () => void;
    route: () => ReturnType<typeof projectRoute>;
    token: () => string | Promise<string>;
    status: number;
    check?: (result: { status: number; body: any }) => void;
  };

  const forbidden = (result: { body: any }) =>
    expect(result.body.code).toBe("forbidden_environment");

  const authCases: AuthCase[] = [
    {
      name: "admits a sibling environment of the claimed organization",
      setup: () => mocks.findFirst.mockResolvedValue({ organizationId: ORGANIZATION_ID }),
      route: () => orgScopedRoute(() => ({ environmentId: "env_prod" })),
      token: orgToken,
      status: 200,
      check: (r) => expect(r.body.organizationId).toBe(ORGANIZATION_ID),
    },
    {
      name: "403s a scope naming both the claimed organization and another org's environment",
      setup: () => mocks.findFirst.mockResolvedValue({ organizationId: "org_other" }),
      route: () =>
        orgScopedRoute(() => ({ organizationId: ORGANIZATION_ID, environmentId: "env_prod" })),
      token: orgToken,
      status: 403,
      check: forbidden,
    },
    {
      name: "admits another project of the claimed organization",
      setup: () => mocks.projectFindFirst.mockResolvedValue({ organizationId: ORGANIZATION_ID }),
      route: () => orgScopedRoute(() => ({ projectId: "proj_other" })),
      token: orgToken,
      status: 200,
    },
    {
      name: "403s the same sibling environment on a route without the flag",
      setup: () => mocks.findFirst.mockResolvedValue({ organizationId: ORGANIZATION_ID }),
      route: () => projectRoute(() => ({ environmentId: "env_prod" })),
      token: orgToken,
      status: 403,
      check: forbidden,
    },
    {
      name: "403s a project of another organization",
      setup: () => mocks.projectFindFirst.mockResolvedValue({ organizationId: "org_other" }),
      route: () => orgScopedRoute(() => ({ projectId: "proj_other" })),
      token: orgToken,
      status: 403,
    },
    {
      name: "admits an org-level route that names nothing, for a current member",
      route: orgLevelRoute,
      token: orgToken,
      status: 200,
      check: (r) => expect(r.body.organizationId).toBe(ORGANIZATION_ID),
    },
    {
      name: "403s a token-organization route for a plain PAT",
      setup: () =>
        mocks.authenticatePat.mockImplementation(async () => ({
          ok: true,
          userId: USER_ID,
          ability: buildJwtAbility(["read:runs"]),
        })),
      route: orgLevelRoute,
      token: () => "tr_pat_1234",
      status: 403,
      check: forbidden,
    },
    {
      // A claimless token from another client passes the environment path untouched, so only the
      // builder's own guard can turn it away.
      name: "403s a token-organization route for a claimless user-actor token",
      setup: () =>
        mocks.authenticateUserActor.mockImplementation(async () =>
          controllerResult({ userId: USER_ID, client: "personal-access-token" })
        ),
      route: orgLevelRoute,
      token: () =>
        signUserActorToken(SESSION_SECRET, {
          userId: USER_ID,
          client: "personal-access-token",
          cap: ["read:runs"],
        }),
      status: 403,
      check: forbidden,
    },
    {
      name: "403s an opted-in route whose projectRef resolves to no organization",
      route: () => orgScopedRoute(() => ({})),
      token: orgToken,
      status: 403,
      // Nothing to check the claim against, so membership is never read.
      check: (r) => {
        forbidden(r);
        expect(mocks.organizationFindFirst).not.toHaveBeenCalled();
      },
    },
    {
      name: "403s a route that names nothing without the token-organization opt-in",
      route: namelessRoute,
      token: orgToken,
      status: 403,
      check: (r) => {
        forbidden(r);
        expect(mocks.organizationFindFirst).not.toHaveBeenCalled();
      },
    },
    {
      name: "403s the org-level route once the user is no longer a member",
      setup: () => mocks.organizationFindFirst.mockResolvedValue(null),
      route: orgLevelRoute,
      token: orgToken,
      status: 403,
      check: forbidden,
    },
    {
      name: "403s an organization claim with no environment claim on a route without the flag",
      setup: () =>
        mocks.authenticateUserActor.mockImplementation(async () =>
          controllerResult({
            userId: USER_ID,
            client: "dashboard-agent",
            organizationId: ORGANIZATION_ID,
          })
        ),
      route: () => projectRoute(() => ({ projectId: "proj_1" })),
      token: () =>
        signUserActorToken(SESSION_SECRET, {
          userId: USER_ID,
          client: "dashboard-agent",
          organizationId: ORGANIZATION_ID,
          cap: ["read:runs"],
        }),
      status: 403,
      check: forbidden,
    },
  ];

  it.each(authCases)("$name", async ({ setup, route, token, status, check }) => {
    setup?.();
    const result = await callRoute(route(), await token());

    expect(result.status).toBe(status);
    check?.(result);
  });

  it("gives an environment that doesn't exist and one in another org the same 403", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    const notFound = await callRoute(
      orgScopedRoute(() => ({ environmentId: "env_missing" })),
      await orgToken()
    );

    mocks.findFirst.mockResolvedValueOnce({ organizationId: "org_other" });
    const foreignOrg = await callRoute(
      orgScopedRoute(() => ({ environmentId: "env_prod" })),
      await orgToken()
    );

    expect(notFound.status).toBe(403);
    expect(notFound).toEqual(foreignOrg);
  });

  it("gives a project that doesn't exist and one in another org the same 403", async () => {
    mocks.projectFindFirst.mockResolvedValueOnce(null);
    const notFound = await callRoute(
      orgScopedRoute(() => ({ projectId: "proj_missing" })),
      await orgToken()
    );

    mocks.projectFindFirst.mockResolvedValueOnce({ organizationId: "org_other" });
    const foreignOrg = await callRoute(
      orgScopedRoute(() => ({ projectId: "proj_other" })),
      await orgToken()
    );

    expect(notFound.status).toBe(403);
    expect(notFound).toEqual(foreignOrg);
  });

  it("applies the environment check to a token with no organization claim", async () => {
    mocks.authenticateUserActor.mockImplementation(async () => controllerResult(agentClaims()));

    const denied = await callRoute(
      orgScopedRoute(() => ({ environmentId: "env_prod" })),
      await agentToken()
    );
    const allowed = await callRoute(
      orgScopedRoute(() => ({ environmentId: CLAIMED_ENVIRONMENT_ID })),
      await agentToken()
    );

    expect(denied.status).toBe(403);
    expect(allowed.status).toBe(200);
    expect(mocks.organizationFindFirst).not.toHaveBeenCalled();
  });
});
