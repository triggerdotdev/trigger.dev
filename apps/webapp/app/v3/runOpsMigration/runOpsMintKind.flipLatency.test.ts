import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { computeRunIdMintKind, type RunIdMintKind } from "./runOpsMintKind.server";

// LOCK of the raw per-process cache's flip-latency behavior in isolation, NOT a change
// request. Production resolveRunIdMintKind now wraps this same staleness in a deterministic
// wall-clock grace window (mintFlipGrace.ts) so every process resolves to the SAME effective
// kind for the whole window, then all cross together. This raw staleness is now an
// intentional, safe input to that resolution. computeRunIdMintKind is unaffected, so this
// suite's assertions stand as-is.

// Bare cached-flag closure — deliberately NOT the production flag fn, which now layers
// grace resolution on top (see runOpsMintKind.server.ts).
function makeCachedFlag(
  cache: BoundedTtlCache<RunIdMintKind>,
  liveFlag: () => RunIdMintKind
): (orgId: string) => Promise<RunIdMintKind> {
  return async (orgId: string) => {
    const cached = cache.get(orgId);
    if (cached !== undefined) return cached;
    const kind = liveFlag();
    cache.set(orgId, kind);
    return kind;
  };
}

const TTL_MS = 30_000;
const env = { organizationId: "org_flip", id: "env_flip" };

describe("computeRunIdMintKind flip latency (mintCache TTL window — current behavior LOCK)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the STALE cached kind within the TTL after the flag flips 'cuid'->'runOpsId'", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "cuid";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // populates the cache

    live = "runOpsId"; // admin flips the org flag
    vi.advanceTimersByTime(TTL_MS - 1); // still inside the window
    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // STALE, as designed
  });

  it("returns the FRESH kind once the TTL expires after a 'cuid'->'runOpsId' flip", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "cuid";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("cuid");

    live = "runOpsId";
    vi.advanceTimersByTime(TTL_MS + 1); // past expiry -> entry evicted on read
    expect(await computeRunIdMintKind(env, deps)).toBe("runOpsId"); // re-reads the live flag
  });

  it("symmetric flip-back 'runOpsId'->'cuid' is also stale within TTL, fresh after", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "runOpsId";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("runOpsId");

    live = "cuid";
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(await computeRunIdMintKind(env, deps)).toBe("runOpsId"); // STALE

    vi.advanceTimersByTime(2); // now past expiry
    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // FRESH
  });
});
