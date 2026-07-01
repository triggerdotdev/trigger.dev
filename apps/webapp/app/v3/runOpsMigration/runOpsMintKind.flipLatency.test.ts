import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { computeRunIdMintKind, type RunIdMintKind } from "./runOpsMintKind.server";

// LOCK of the CURRENT (intentional) flip-latency behavior, NOT a change request.
// resolveRunIdMintKind caches the per-org mint kind in a process-singleton
// BoundedTtlCache (TTL RUN_OPS_MINT_FLAG_CACHE_TTL_MS, 30000ms default) with get/set
// and NO invalidation hook (runOpsMintKind.server.ts:38-45,56-81). So after a flag
// flip a process keeps minting the stale kind until its cached entry expires; in
// multi-instance prod each process expires independently. This suite reconstructs the
// same flag fn over a real cache and pins both edges of that window.

// Mirror of resolveRunIdMintKind's flag fn (runOpsMintKind.server.ts:56-81).
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

  it("returns the STALE cached kind within the TTL after the flag flips cuid->ksuid", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "cuid";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // populates the cache

    live = "ksuid"; // admin flips the org flag
    vi.advanceTimersByTime(TTL_MS - 1); // still inside the window
    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // STALE, as designed
  });

  it("returns the FRESH kind once the TTL expires after a cuid->ksuid flip", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "cuid";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("cuid");

    live = "ksuid";
    vi.advanceTimersByTime(TTL_MS + 1); // past expiry -> entry evicted on read
    expect(await computeRunIdMintKind(env, deps)).toBe("ksuid"); // re-reads the live flag
  });

  it("symmetric flip-back ksuid->cuid is also stale within TTL, fresh after", async () => {
    const cache = new BoundedTtlCache<RunIdMintKind>(TTL_MS, 100);
    let live: RunIdMintKind = "ksuid";
    const flag = makeCachedFlag(cache, () => live);
    const deps = { masterEnabled: true, splitEnabled: async () => true, flag };

    expect(await computeRunIdMintKind(env, deps)).toBe("ksuid");

    live = "cuid";
    vi.advanceTimersByTime(TTL_MS - 1);
    expect(await computeRunIdMintKind(env, deps)).toBe("ksuid"); // STALE

    vi.advanceTimersByTime(2); // now past expiry
    expect(await computeRunIdMintKind(env, deps)).toBe("cuid"); // FRESH
  });
});
