import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A delegated (agent/PAT-minted) env JWT rotates its token value every turn. Keying the
 * rate limiter on the token would hand each turn a fresh bucket, so the limiter keys on
 * env+acting-user instead — stable across turns, namespaced away from PRIVATE-key buckets.
 */

const mocks = vi.hoisted(() => ({
  authenticateAuthorizationHeader: vi.fn<(...args: any[]) => Promise<any>>(),
  resolvePrivateApiKeyRateLimitScope: vi.fn<(...args: any[]) => Promise<any>>(),
}));

// Importing the module constructs the real middleware at load; stub the constructor and env
// so the test doesn't reach for redis or the env contract.
vi.mock("~/services/authorizationRateLimitMiddleware.server", () => ({
  authorizationRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("~/env.server", () => ({
  env: { API_RATE_LIMIT_JWT_WINDOW: "1m", API_RATE_LIMIT_JWT_TOKENS: 100 },
}));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  resolvePrivateApiKeyRateLimitScope: mocks.resolvePrivateApiKeyRateLimitScope,
}));
vi.mock("~/runEngine/concerns/batchStreamGrantsInstance.server", () => ({
  batchStreamGrants: { spend: vi.fn() },
}));
vi.mock("~/services/apiAuth.server", () => ({
  authenticateAuthorizationHeader: mocks.authenticateAuthorizationHeader,
}));

import {
  jwtActorRateLimitIdentifier,
  resolveApiRateLimitOverride,
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
