import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * A user-actor token minted from a PAT is bound to that PAT (`claims.pat`) and must stop
 * working once the PAT is revoked. `assertSourcePatActive` is the recheck the host runs at
 * every UAT verify site; a token with no source PAT (e.g. the dashboard agent's) skips it.
 * The mint route also caps the requested lifetime at a 7-day ceiling.
 */

const { SESSION_SECRET } = vi.hoisted(() => ({
  SESSION_SECRET: "test-session-secret-for-source-pat-recheck",
}));

const mocks = vi.hoisted(() => ({
  patFindFirst: vi.fn<(...args: any[]) => Promise<any>>(),
  authenticatePat: vi.fn<(...args: any[]) => Promise<any>>(),
  getTokenRole: vi.fn<(...args: any[]) => Promise<any>>(),
}));

vi.mock("~/env.server", () => ({
  env: { SESSION_SECRET, ENCRYPTION_KEY: "0123456789abcdef0123456789abcdef" },
}));
vi.mock("~/services/logger.server", () => ({
  logger: { debug: vi.fn(), error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));
vi.mock("~/services/rbac.server", () => ({
  rbac: { authenticatePat: mocks.authenticatePat, getTokenRole: mocks.getTokenRole },
}));
vi.mock("~/db.server", () => ({
  prisma: { personalAccessToken: { findFirst: mocks.patFindFirst } },
}));

import { signUserActorToken, verifyUserActorToken } from "@trigger.dev/rbac";
import { action as mintAction } from "~/routes/api.v1.auth.user-actor-token";
import {
  assertSourcePatActive,
  resolveAndRecheckUserActorClaims,
} from "~/services/personalAccessToken.server";

const SEVEN_DAYS = 7 * 24 * 60 * 60;

describe("assertSourcePatActive", () => {
  beforeEach(() => {
    mocks.patFindFirst.mockReset();
  });

  it("no-ops (returns true, no DB read) when the token carries no source PAT", async () => {
    expect(await assertSourcePatActive({ userId: "usr_1" })).toBe(true);
    expect(mocks.patFindFirst).not.toHaveBeenCalled();
  });

  it("returns true when the source PAT is still live", async () => {
    mocks.patFindFirst.mockResolvedValue({ id: "pat_1234" });

    expect(await assertSourcePatActive({ userId: "usr_1", pat: "pat_1234" })).toBe(true);
    expect(mocks.patFindFirst).toHaveBeenCalledWith({
      where: { id: "pat_1234", revokedAt: null },
      select: { id: true },
    });
  });

  it("returns false when the source PAT was revoked or is gone", async () => {
    mocks.patFindFirst.mockResolvedValue(null);

    expect(await assertSourcePatActive({ userId: "usr_1", pat: "pat_1234" })).toBe(false);
  });
});

describe("resolveAndRecheckUserActorClaims (apiBuilder verify site)", () => {
  beforeEach(() => {
    mocks.patFindFirst.mockReset();
  });

  async function tokenWithPat(pat: string) {
    return signUserActorToken(SESSION_SECRET, {
      userId: "usr_1",
      client: "cli",
      pat,
    });
  }

  it("acts on the verified claims, not the plugin's narrower copy", async () => {
    // A plugin predating a claim delivers an incomplete set; scoping on it would widen access.
    mocks.patFindFirst.mockResolvedValue({ id: "pat_1234" });
    const bearer = await signUserActorToken(SESSION_SECRET, {
      userId: "usr_1",
      client: "cli",
      pat: "pat_1234",
      environmentId: "env_1234",
    });

    const result = await resolveAndRecheckUserActorClaims({ userId: "usr_1" }, bearer);

    expect(result).toMatchObject({ userId: "usr_1", environmentId: "env_1234", pat: "pat_1234" });
  });

  it("denies when the source PAT was revoked", async () => {
    mocks.patFindFirst.mockResolvedValue(null);
    const bearer = await tokenWithPat("pat_1234");

    // Plugin supplies claims; the bearer's own `pat` is what must be rechecked.
    const result = await resolveAndRecheckUserActorClaims({ userId: "usr_1" }, bearer);

    expect(result).toBeUndefined();
  });

  it("allows when the source PAT is still live", async () => {
    mocks.patFindFirst.mockResolvedValue({ id: "pat_1234" });
    const bearer = await tokenWithPat("pat_1234");

    const result = await resolveAndRecheckUserActorClaims({ userId: "usr_1" }, bearer);

    expect(result).toMatchObject({ userId: "usr_1" });
  });

  it("rechecks the token's authoritative pat even when plugin claims omit it", async () => {
    // A stale RBAC plugin delivers pat-less claims; trusting them would no-op revocation.
    // We re-verify the bearer, so the revoked source PAT is still caught here.
    mocks.patFindFirst.mockResolvedValue(null);
    const bearer = await tokenWithPat("pat_1234");

    const result = await resolveAndRecheckUserActorClaims({ userId: "usr_1" /* no pat */ }, bearer);

    expect(result).toBeUndefined();
    expect(mocks.patFindFirst).toHaveBeenCalledWith({
      where: { id: "pat_1234", revokedAt: null },
      select: { id: true },
    });
  });
});

describe("mint user-actor token route", () => {
  beforeEach(() => {
    mocks.authenticatePat.mockReset();
    mocks.getTokenRole.mockReset();
    mocks.authenticatePat.mockResolvedValue({ ok: true, tokenId: "pat_1234", userId: "usr_1" });
    mocks.getTokenRole.mockResolvedValue(null);
  });

  function mint(body: unknown) {
    return mintAction({
      request: new Request("https://example.com/api/v1/auth/user-actor-token", {
        method: "POST",
        headers: { Authorization: "Bearer tr_pat_abc", "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      params: {},
      context: {} as any,
    }) as Promise<Response>;
  }

  it("400s a TTL above the 7-day ceiling", async () => {
    const response = await mint({ ttlSeconds: SEVEN_DAYS + 1 });

    expect(response.status).toBe(400);
  });

  it("mints a token bound to its source PAT at the ceiling", async () => {
    const response = await mint({ ttlSeconds: SEVEN_DAYS });

    expect(response.status).toBe(200);
    const { token } = (await response.json()) as { token: string };
    const claims = await verifyUserActorToken(SESSION_SECRET, token);
    expect(claims?.pat).toBe("pat_1234");
  });
});
