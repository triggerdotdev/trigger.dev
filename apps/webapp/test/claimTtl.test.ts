import { describe, expect, it } from "vitest";
import { computeClaimTtlSeconds } from "~/v3/mollifier/claimTtl";

// The mollifier idempotency claim is a serialization lock that must outlive the winner's
// create-and-publish pipeline. If its TTL is derived from the customer's key TTL alone, a short key
// TTL expires the claim mid-pipeline and a polling loser re-claims → a second creator → cross-DB dup.
describe("computeClaimTtlSeconds", () => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  const minTtlSeconds = 5;
  const maxTtlSeconds = 30;

  it("floors a short key TTL at the pipeline minimum (claim can't expire mid-pipeline)", () => {
    expect(
      computeClaimTtlSeconds({
        keyExpiresAt: new Date(now + 2_000),
        now,
        minTtlSeconds,
        maxTtlSeconds,
      })
    ).toBe(5);
  });

  it("caps a long key TTL at the maximum", () => {
    expect(
      computeClaimTtlSeconds({
        keyExpiresAt: new Date(now + 3_600_000),
        now,
        minTtlSeconds,
        maxTtlSeconds,
      })
    ).toBe(30);
  });

  it("uses the key TTL when it sits between the floor and the cap", () => {
    expect(
      computeClaimTtlSeconds({
        keyExpiresAt: new Date(now + 12_000),
        now,
        minTtlSeconds,
        maxTtlSeconds,
      })
    ).toBe(12);
  });

  it("floors an already-expired key at the minimum", () => {
    expect(
      computeClaimTtlSeconds({
        keyExpiresAt: new Date(now - 1_000),
        now,
        minTtlSeconds,
        maxTtlSeconds,
      })
    ).toBe(5);
  });
});
