import { LRUCache } from "lru-cache";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";

const DEFAULT_CACHE_MAX = 50_000;

export type SnapshotRunOrgSource = {
  /**
   * A PURE cache get: the cached org id, or undefined on a miss. Never queries, never blocks, never
   * throws. The hot read path calls this, so it does no work — a resident run's mapping is put here
   * for free by `prime`, from a mirrored write or a Redis read hit, and a non-resident run never
   * needs one. There is deliberately no off-path populate: during pure dual-write the read path must
   * issue zero run→org DB reads fleet-wide.
   */
  resolve(runId: string): string | undefined;
  /**
   * Records a run→org mapping the caller learned for free — from a mirrored write or a Redis read
   * hit — so a later `resolve` is a pure hit with no DB read. In-memory, immutable (run→org never
   * changes), no TTL, no invalidation. Fire-and-forget: never queries, never throws.
   */
  prime(runId: string, organizationId: string): void;
};

export function createSnapshotRunOrgSource(): SnapshotRunOrgSource {
  // No ttl: run→org is immutable, so a cached mapping never goes stale.
  const cache = new LRUCache<string, string>({
    max: env.RUN_ENGINE_SNAPSHOT_STORE_RUN_ORG_CACHE_MAX ?? DEFAULT_CACHE_MAX,
  });

  return {
    resolve(runId) {
      return cache.get(runId);
    },
    prime(runId, organizationId) {
      // run→org is immutable, so this can only ever confirm what is already there; setting keeps the
      // active run hot in the LRU, which is exactly the run whose mapping the read path will want.
      cache.set(runId, organizationId);
    },
  };
}

/** Built on first use, never at import: importing this module must have no side effect. */
export function snapshotRunOrgSource(): SnapshotRunOrgSource {
  return singleton("snapshotRunOrgSource", () => createSnapshotRunOrgSource());
}
