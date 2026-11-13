import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A delegated (agent/PAT-minted) env JWT rotates its token value every turn. Keying the
 * rate limiter on the token would hand each turn a fresh bucket, so the limiter keys on
 * env+acting-user instead — stable across turns, namespaced away from PRIVATE-key buckets.
 */

const mocks = vi.hoisted(() => ({
  authenticateAuthorizationHeader: vi.fn<(...args: any[]) => Promise<any>>(),
  resolvePrivateApiKeyRateLimitScope: vi.fn<(...args: any[]) => Promise<any>>(),
  resolveRunToken: vi.fn<(...args: any[]) => Promise<any>>(),
}));

// Importing the module constructs the real middleware at load; stub the constructor and env
// so the test doesn't reach for redis or the env contract.
vi.mock("~/services/authorizationRateLimitMiddleware.server", () => ({
  authorizationRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("~/env.server", () => ({
  env: {
    API_RATE_LIMIT_JWT_WINDOW: "1m",
    API_RATE_LIMIT_JWT_TOKENS: 100,
    SESSION_SECRET: "test-secret",
    MCP_ORIGIN: "https://mcp.test",
  },
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  resolvePrivateApiKeyRateLimitScope: mocks.resolvePrivateApiKeyRateLimitScope,
}));
vi.mock("~/runEngine/concerns/batchStreamGrantsInstance.server", () => ({
  batchStreamGrants: { spend: vi.fn() },
}));
vi.mock("~/services/oidc/runTokenAuth.server", () => ({
  resolveRunToken: mocks.resolveRunToken,
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateAuthorizationHeader: mocks.authenticateAuthorizationHeader,
}));
vi.mock("~/services/apiRateLimitMetrics.server", () => ({
  recordApiRateLimitObservation: vi.fn(),
  initApiRateLimitMetrics: vi.fn(),
}));

import { signUserActorToken } from "@trigger.dev/rbac";
import {
  jwtActorRateLimitIdentifier,
  readApiRateLimitMetricsFlag,
  resolveApiRateLimitOverride,
  userActorRateLimitIdentifier,
} from "~/services/apiRateLimit.server";

describe("jwtActorRateLimitIdentifier", () => {
  it("is stable across token value — depends only on env + acting user", () => {
    // Two turns of the same agent: different JWTs, same env + act.sub.
    const first = jwtActorRateLimitIdentifier("env_123", "usr_abc");
    const second = jwtActorRateLimitIdentifier("env_123", "usr_abc");

    expect(first).toBe(second);
    expect(first).toBe("jwt-actor:env_123:usr_abc");
  });

  it("is namespaced so it can't collide with a PRIVATE-key bucket (bare env id)", () => {
    const identifier = jwtActorRateLimitIdentifier("env_123", "usr_abc");

    expect(identifier.startsWith("jwt-actor:")).toBe(true);
    expect(identifier).not.toBe("env_123");
  });

  it("is compound: a different user in the same env gets a different bucket", () => {
    expect(jwtActorRateLimitIdentifier("env_123", "usr_abc")).not.toBe(
      jwtActorRateLimitIdentifier("env_123", "usr_xyz")
    );
    expect(jwtActorRateLimitIdentifier("env_123", "usr_abc")).not.toBe(
      jwtActorRateLimitIdentifier("env_999", "usr_abc")
    );
  });
});

/**
 * The PUBLIC_JWT branch of the real override. These exercise the `actor?.sub` guard itself —
 * they fail if the guard is deleted or the (environmentId, actor.sub) args are swapped.
 */
describe("resolveApiRateLimitOverride — PUBLIC_JWT branch", () => {
  // A JWT bearer isn't `tr_`-prefixed, so it skips the private-key branch and hits auth.
  const JWT_BEARER = "Bearer eyJ.delegated.jwt";

  beforeEach(() => {
    mocks.authenticateAuthorizationHeader.mockReset();
    mocks.resolvePrivateApiKeyRateLimitScope.mockReset();
  });

  it("keys a delegated JWT (act.sub present) on jwt-actor:${env}:${sub}", async () => {
    mocks.authenticateAuthorizationHeader.mockResolvedValue({
      ok: true,
      type: "PUBLIC_JWT",
      environment: { id: "env_777" },
      actor: { sub: "usr_555" },
    });

    const override = await resolveApiRateLimitOverride(JWT_BEARER);

    expect(override?.identifier).toBe("jwt-actor:env_777:usr_555");
    expect(override?.config).toBeDefined();
  });

  it("leaves a realtime JWT (no act) on the hashed-token fallback (no identifier)", async () => {
    mocks.authenticateAuthorizationHeader.mockResolvedValue({
      ok: true,
      type: "PUBLIC_JWT",
      environment: { id: "env_777" },
      // no `actor`
    });

    const override = await resolveApiRateLimitOverride(JWT_BEARER);

    expect(override?.identifier).toBeUndefined();
    expect(override?.config).toBeDefined();
  });
});

/**
 * Only private-key (`tr_`) buckets carry a tenant: that is the per-environment bucket the
 * documented limit refers to, so it is the only one that feeds the rate limit metrics.
 */
describe("resolveApiRateLimitOverride — tenant", () => {
  beforeEach(() => {
    mocks.authenticateAuthorizationHeader.mockReset();
    mocks.resolvePrivateApiKeyRateLimitScope.mockReset();
  });

  it("attaches the environment's tenant on the private-key branch", async () => {
    const config = { type: "fixedWindow", window: "1m", tokens: 10 };
    mocks.resolvePrivateApiKeyRateLimitScope.mockResolvedValue({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "proj_1",
      apiRateLimiterConfig: config,
      featureFlags: null,
    });

    const override = await resolveApiRateLimitOverride("Bearer tr_prod_sk_abcdefghijklmnop");

    expect(mocks.authenticateAuthorizationHeader).not.toHaveBeenCalled();
    expect(override).toEqual({
      config,
      identifier: "env_1",
      tenant: {
        organizationId: "org_1",
        projectId: "proj_1",
        environmentId: "env_1",
        metricsEnabled: false,
      },
    });
  });

  it("carries the organization's metrics opt-in flag on the tenant", async () => {
    mocks.resolvePrivateApiKeyRateLimitScope.mockResolvedValue({
      environmentId: "env_1",
      organizationId: "org_1",
      projectId: "proj_1",
      apiRateLimiterConfig: null,
      featureFlags: { apiRateLimitMetricsEnabled: true, hasQueryAccess: true },
    });

    const override = await resolveApiRateLimitOverride("Bearer tr_prod_sk_abcdefghijklmnop");

    expect(override?.tenant?.metricsEnabled).toBe(true);
  });

  it("returns no override for an unknown private key", async () => {
    mocks.resolvePrivateApiKeyRateLimitScope.mockResolvedValue(null);

    const override = await resolveApiRateLimitOverride("Bearer tr_prod_sk_unknown");

    expect(override).toBeUndefined();
  });

  it("attaches no tenant on the PUBLIC_JWT branch", async () => {
    mocks.authenticateAuthorizationHeader.mockResolvedValue({
      ok: true,
      type: "PUBLIC_JWT",
      environment: { id: "env_777" },
      actor: { sub: "usr_555" },
    });

    const override = await resolveApiRateLimitOverride("Bearer eyJ.delegated.jwt");

    expect(override?.identifier).toBe("jwt-actor:env_777:usr_555");
    expect(override?.tenant).toBeUndefined();
  });
});

describe("readApiRateLimitMetricsFlag", () => {
  it("is on only for an explicit boolean true in the organization override", () => {
    expect(readApiRateLimitMetricsFlag({ apiRateLimitMetricsEnabled: true })).toBe(true);
    expect(readApiRateLimitMetricsFlag({ apiRateLimitMetricsEnabled: false })).toBe(false);
    expect(readApiRateLimitMetricsFlag({ apiRateLimitMetricsEnabled: "true" })).toBe(false);
    expect(readApiRateLimitMetricsFlag({ hasQueryAccess: true })).toBe(false);
    expect(readApiRateLimitMetricsFlag(null)).toBe(false);
    expect(readApiRateLimitMetricsFlag(undefined)).toBe(false);
    expect(readApiRateLimitMetricsFlag("garbage")).toBe(false);
    expect(readApiRateLimitMetricsFlag([])).toBe(false);
  });
});

describe("resolveApiRateLimitOverride — run tokens", () => {
  // Only the header is read to classify the token; verification is mocked.
  const runToken = `${Buffer.from(JSON.stringify({ alg: "RS256", typ: "run+jwt" })).toString(
    "base64url"
  )}.payload.signature`;
  const environment = {
    id: "env_1",
    organizationId: "org_1",
    projectId: "proj_1",
    organization: { apiRateLimiterConfig: null, featureFlags: null },
  };

  beforeEach(() => {
    mocks.authenticateAuthorizationHeader.mockReset();
    mocks.resolveRunToken.mockReset();
  });

  it.each([`Bearer ${runToken}`, `Bearer  ${runToken}`, `Bearer ${runToken} `])(
    "shares the environment bucket for %j",
    async (header) => {
      mocks.resolveRunToken.mockResolvedValue({ environment, claims: {} });

      const override = await resolveApiRateLimitOverride(header);

      expect(mocks.resolveRunToken).toHaveBeenCalledWith(runToken);
      expect(override?.identifier).toBe("env_1");
      expect(mocks.authenticateAuthorizationHeader).not.toHaveBeenCalled();
    }
  );

  it("returns no override for an invalid run token", async () => {
    mocks.resolveRunToken.mockResolvedValue(undefined);

    await expect(resolveApiRateLimitOverride(`Bearer ${runToken}`)).resolves.toBeUndefined();
  });
});

describe("resolveApiRateLimitOverride — user-actor tokens", () => {
  // A distinct sessionId makes each mint a different token, like a fresh UAT from the same PAT.
  const mint = (
    opts: { userId: string; pat?: string; expirationTime?: number },
    sessionId: string,
    secret = "test-secret"
  ) => signUserActorToken(secret, { client: "mcp", sessionId, ...opts });

  beforeEach(() => {
    mocks.authenticateAuthorizationHeader.mockReset();
    mocks.resolvePrivateApiKeyRateLimitScope.mockReset();
  });

  it.each([
    ["the source PAT", { userId: "usr_1", pat: "pat_1" }, "pat:pat_1"],
    ["the user when there is no PAT", { userId: "usr_1" }, "user:usr_1"],
  ])("keys a UAT on %s, not on the token", async (_name, opts, expected) => {
    const a = await resolveApiRateLimitOverride(`Bearer ${await mint(opts, "s1")}`);
    const b = await resolveApiRateLimitOverride(`Bearer ${await mint(opts, "s2")}`);

    expect(a?.identifier).toBe(expected);
    expect(b?.identifier).toBe(expected);
    expect(mocks.resolvePrivateApiKeyRateLimitScope).not.toHaveBeenCalled();
  });

  // Catches: dropping the MCP-audience retry, so every refreshed MCP token gets its own bucket.
  it("keys MCP-audience UATs from the same grant on one bucket", async () => {
    const mintMcp = (sessionId: string) =>
      signUserActorToken("test-secret", {
        userId: "usr_1",
        pat: "pat_1",
        client: "mcp",
        sessionId,
        audience: "https://mcp.test/mcp",
      });

    const a = await resolveApiRateLimitOverride(`Bearer ${await mintMcp("s1")}`);
    const b = await resolveApiRateLimitOverride(`Bearer ${await mintMcp("s2")}`);

    expect(a?.identifier).toBe("pat:pat_1");
    expect(b?.identifier).toBe("pat:pat_1");
  });

  it("does not share a bucket between different PATs", async () => {
    expect(
      await userActorRateLimitIdentifier(await mint({ userId: "usr_1", pat: "pat_1" }, "s1"))
    ).not.toBe(
      await userActorRateLimitIdentifier(await mint({ userId: "usr_1", pat: "pat_2" }, "s1"))
    );
  });

  it("does not let a forged UAT (wrong signature) borrow a victim's bucket", async () => {
    const forged = await mint({ userId: "usr_victim", pat: "pat_victim" }, "s1", "attacker-secret");

    await expect(resolveApiRateLimitOverride(`Bearer ${forged}`)).resolves.toBeUndefined();
  });

  it("falls back to the token hash for an expired UAT", async () => {
    const expired = await mint(
      { userId: "usr_1", pat: "pat_1", expirationTime: Math.floor(Date.now() / 1000) - 60 },
      "s1"
    );

    await expect(resolveApiRateLimitOverride(`Bearer ${expired}`)).resolves.toBeUndefined();
  });

  it.each(["tr_uat_", "tr_uat_garbage", "tr_uat_a.!!!.c"])(
    "falls back to the token hash for malformed UAT %j",
    async (token) => {
      await expect(resolveApiRateLimitOverride(`Bearer ${token}`)).resolves.toBeUndefined();
    }
  );
});
