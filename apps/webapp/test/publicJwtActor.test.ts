import { describe, expect, it } from "vitest";
import { publicJwtActor, signPublicJwtActor } from "~/services/publicJwtActor.server";

const secret = "test-public-token-secret";
const actor = { sub: "usr_1", client: "cli", pat: "pat_v1_sealed" };
const claims = { environmentId: "env_1", expiresAt: 1_900_000_000, scopes: ["read:runs"] };
const sig = signPublicJwtActor(secret, actor, claims);

describe("public JWT actor signature", () => {
  it("verifies a user the server signed with exactly these claims", () => {
    expect(publicJwtActor(secret, { ...actor, sig }, claims)).toEqual({
      ...actor,
      verified: true,
    });
  });

  // Catches: a root key holder's own `act`, with no server signature, being trusted.
  it("passes an unsigned user through unverified", () => {
    expect(publicJwtActor(secret, { sub: "usr_1" }, claims)).toEqual({
      sub: "usr_1",
      verified: false,
    });
  });

  // Catches: a real signature reused to name another user, environment or lifetime.
  it("rejects a signature made for another user, environment or expiry", () => {
    expect(publicJwtActor(secret, { ...actor, sub: "usr_2", sig }, claims).verified).toBe(false);
    expect(
      publicJwtActor(secret, { ...actor, sig }, { ...claims, environmentId: "env_2" }).verified
    ).toBe(false);
    expect(
      publicJwtActor(secret, { ...actor, sig }, { ...claims, expiresAt: claims.expiresAt + 1 })
        .verified
    ).toBe(false);
  });

  // Catches: a real signature copied onto a token that may do more than the one it was made for.
  it("rejects a signature copied onto a token with other rights", () => {
    const verifiedWith = (overrides: Record<string, unknown>) =>
      publicJwtActor(secret, { ...actor, sig }, { ...claims, ...overrides }).verified;

    expect(verifiedWith({ scopes: ["read:runs", "write:all"] })).toBe(false);
    expect(verifiedWith({ scopes: [] })).toBe(false);
    expect(verifiedWith({ oneTimeUse: true })).toBe(false);
    expect(verifiedWith({ realtime: { skipColumns: ["payload"] } })).toBe(false);
  });

  // Catches: a signature surviving a changed client, or a dropped or swapped source PAT.
  it("rejects a signature on an act with another client or source PAT", () => {
    const verifiedFor = (act: Record<string, unknown>) =>
      publicJwtActor(secret, { sub: "usr_1", ...act, sig }, claims).verified;

    expect(verifiedFor({ client: "dashboard-agent", pat: actor.pat })).toBe(false);
    // Without `pat`, revoking the PAT would no longer end the token.
    expect(verifiedFor({ client: actor.client })).toBe(false);
    expect(verifiedFor({ client: actor.client, pat: "pat_v1_other" })).toBe(false);
  });

  it("verifies the same claims in another order", () => {
    const scoped = { ...claims, scopes: ["read:runs", "read:tasks"] };
    const scopedSig = signPublicJwtActor(secret, actor, scoped);

    expect(
      publicJwtActor(
        secret,
        { ...actor, sig: scopedSig },
        { ...scoped, scopes: ["read:tasks", "read:runs"] }
      ).verified
    ).toBe(true);
  });

  // Catches: a signature checked against a different server secret, or a token with no expiry.
  it("rejects a signature under another secret or without an expiry", () => {
    expect(publicJwtActor("another-secret", { ...actor, sig }, claims).verified).toBe(false);
    expect(
      publicJwtActor(secret, { ...actor, sig }, { ...claims, expiresAt: undefined }).verified
    ).toBe(false);
  });

  // Catches: a token with malformed claims failing the request instead of verifying as false.
  it("rejects malformed claims without throwing", () => {
    const malformed = { ...claims, realtime: { skipColumns: 5 } } as unknown as typeof claims;
    expect(publicJwtActor(secret, { ...actor, sig }, malformed).verified).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(publicJwtActor(secret, { ...actor, sig: "short" }, claims).verified).toBe(false);
  });

  it("returns nothing when the token has no act", () => {
    expect(publicJwtActor(secret, undefined, claims)).toBeUndefined();
  });
});
