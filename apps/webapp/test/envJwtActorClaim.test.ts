import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  authenticateRequest: vi.fn<(...args: any[]) => Promise<any>>(),
  verifyUserActorToken: vi.fn<(...args: any[]) => Promise<any>>(),
  isUserActorToken: vi.fn<(value: string) => boolean>(),
  authenticateUatOrApiRequest: vi.fn<(...args: any[]) => Promise<any>>(),
  authorizePatEnvironmentAccess: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("@trigger.dev/rbac", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isUserActorToken: mocks.isUserActorToken,
  verifyUserActorToken: mocks.verifyUserActorToken,
}));
vi.mock("~/services/environmentVariableApiAccess.server", () => ({
  authorizePatEnvironmentAccess: mocks.authorizePatEnvironmentAccess,
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticatedEnvironmentForAuthentication: vi.fn(async () => environment),
  branchNameFromRequest: () => undefined,
  authenticateRequest: mocks.authenticateRequest,
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/env.server", () => ({ env: { SESSION_SECRET: "test-session-secret" } }));
// The 401 path looks up why the token failed; an unknown token has no row.
vi.mock("~/db.server", () => ({
  prisma: {},
  $replica: { personalAccessToken: { findFirst: async () => null } },
}));

import { validateJWT } from "@trigger.dev/core/v3/jwt";
import { action } from "~/routes/api.v1.projects.$projectRef.$env.jwt";

const environment = {
  id: "env_1234",
  apiKey: "tr_prod_abcdefghijklmnop",
  organizationId: "org_1234",
  type: "PRODUCTION" as const,
  project: { id: "proj_1234" },
};

const params = { projectRef: "proj_abc", env: "prod" };

function request(body: unknown = {}, bearer = "tr_pat_test") {
  return new Request("https://example.com/api/v1/projects/proj_abc/prod/jwt", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${bearer}` },
    body: JSON.stringify(body),
  });
}

async function mintedClaims(body?: unknown) {
  const response = await action({ request: request(body), params, context: {} as any });
  const { token } = (await response.json()) as { token: string };
  const result = await validateJWT(token, environment.apiKey);
  if (!result.ok) throw new Error("minted token failed validation");
  return result.payload as Record<string, any>;
}

describe("env JWT exchange — act claim", () => {
  beforeEach(() => {
    mocks.authenticateRequest.mockReset();
    mocks.verifyUserActorToken.mockReset();
    mocks.isUserActorToken.mockReset();
    mocks.isUserActorToken.mockReturnValue(false);
    mocks.authorizePatEnvironmentAccess.mockReset();
    mocks.authorizePatEnvironmentAccess.mockResolvedValue(undefined);
  });

  it("stamps the PAT's user with the personal-access-token client", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      type: "personalAccessToken",
      result: { userId: "usr_42" },
    });

    const claims = await mintedClaims();

    expect(claims.act).toEqual({ sub: "usr_42", client: "personal-access-token" });
    expect(claims.sub).toBe(environment.id);
  });

  it("passes through a user-actor token's own client", async () => {
    mocks.isUserActorToken.mockReturnValue(true);
    mocks.verifyUserActorToken.mockResolvedValue({
      userId: "usr_7",
      client: "dashboard-agent",
      // An agent token always carries the environment it was minted for.
      environmentId: environment.id,
      cap: ["read:runs"],
    });

    const claims = await mintedClaims({ claims: { scopes: ["read:runs"] } });

    expect(claims.act).toEqual({ sub: "usr_7", client: "dashboard-agent" });
    expect(claims.scopes).toEqual(["read:runs"]);
  });

  it("omits act for an org access token (no user)", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      type: "organizationAccessToken",
      result: { organizationId: "org_1" },
    });

    const claims = await mintedClaims();

    expect(claims.act).toBeUndefined();
    expect(claims.sub).toBe(environment.id);
  });

  it("doesn't let a JWT outlive the PAT it was exchanged from", async () => {
    const validUntil = new Date(Date.now() + 10 * 60 * 1000);
    mocks.authenticateRequest.mockResolvedValue({
      type: "personalAccessToken",
      result: { userId: "usr_42", validUntil },
    });

    const claims = await mintedClaims({ expirationTime: "24h" });

    expect(claims.exp).toBe(Math.floor(validUntil.getTime() / 1000));
  });

  it("grants the requested lifetime when the PAT doesn't expire sooner", async () => {
    mocks.authenticateRequest.mockResolvedValue({
      type: "personalAccessToken",
      result: { userId: "usr_42" },
    });
    const before = Math.floor(Date.now() / 1000);

    const claims = await mintedClaims({ expirationTime: "1h" });

    expect(claims.exp).toBeGreaterThanOrEqual(before + 60 * 60);
    expect(claims.exp).toBeLessThanOrEqual(before + 60 * 60 + 5);
  });

  it("401s without a token", async () => {
    mocks.authenticateRequest.mockResolvedValue(undefined);

    const response = await action({ request: request(), params, context: {} as any });

    expect(response.status).toBe(401);
  });
});
