import { describe, expect, it, vi } from "vitest";

/**
 * A delegated (agent/PAT-minted) env JWT rotates its token value every turn. Keying the
 * rate limiter on the token would hand each turn a fresh bucket, so the limiter keys on
 * env+acting-user instead — stable across turns, namespaced away from PRIVATE-key buckets.
 */

// Importing the module constructs the real middleware at load; stub the constructor and env
// so the test doesn't reach for redis or the env contract.
vi.mock("~/services/authorizationRateLimitMiddleware.server", () => ({
  authorizationRateLimitMiddleware: () => (_req: any, _res: any, next: any) => next(),
}));
vi.mock("~/env.server", () => ({ env: {} }));
vi.mock("~/models/runtimeEnvironment.server", () => ({
  resolvePrivateApiKeyRateLimitScope: vi.fn(),
}));
vi.mock("~/runEngine/concerns/batchStreamGrantsInstance.server", () => ({
  batchStreamGrants: { spend: vi.fn() },
}));
vi.mock("~/services/apiAuth.server", () => ({ authenticateAuthorizationHeader: vi.fn() }));

import { jwtActorRateLimitIdentifier } from "~/services/apiRateLimit.server";

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
