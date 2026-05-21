// Behavioural test for `createLoaderPATApiRoute` to confirm PAT-authenticated
// requests stamp `userId` onto the tenant context (so Sentry events from
// PAT routes get user-level attribution).
//
// PAT auth normally hits the DB via `rbac.authenticatePat`. To keep this
// a unit test, we stub the two DB-touching dependencies — narrow enough
// that the test exercises the wrapping behaviour without bringing up a
// real database.

import { describe, it, expect, vi } from "vitest";

vi.mock("~/services/rbac.server", () => ({
  rbac: {
    authenticatePat: vi.fn(async () => ({
      ok: true,
      userId: "usr_test_42",
      ability: {},
      tokenId: "tok_1",
      lastAccessedAt: new Date(),
    })),
  },
}));

vi.mock("~/services/personalAccessToken.server", async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    updateLastAccessedAtIfStale: vi.fn(async () => undefined),
  };
});

import { tenantContext } from "../app/services/tenantContext.server";
import { createLoaderPATApiRoute } from "../app/services/routeBuilders/apiBuilder.server";

describe("createLoaderPATApiRoute", () => {
  it("enriches tenant context with `userId` from the PAT auth result", async () => {
    let observedUserId: string | undefined;

    const loader = createLoaderPATApiRoute({}, async () => {
      observedUserId = tenantContext.get()?.userId;
      return new Response(null, { status: 200 });
    });

    await tenantContext.run({}, async () => {
      await loader({
        request: new Request("http://localhost/api/test", {
          headers: { Authorization: "Bearer pat_irrelevant_for_this_test" },
        }),
        params: {},
        context: {},
      });
    });

    expect(observedUserId).toBe("usr_test_42");
  });

  it("does not leak the enrich across requests once the scope ends", async () => {
    const loader = createLoaderPATApiRoute({}, async () => {
      return new Response(null, { status: 200 });
    });

    await tenantContext.run({}, async () => {
      await loader({
        request: new Request("http://localhost/api/test", {
          headers: { Authorization: "Bearer pat_irrelevant_for_this_test" },
        }),
        params: {},
        context: {},
      });
    });

    // Outside the run() scope, the enrich is gone with the scope.
    expect(tenantContext.get()).toBeUndefined();
  });
});
