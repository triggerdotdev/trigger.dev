import { LRUCache } from "lru-cache";

export type Residency = "resident" | "non-resident";

/** Entries, not bytes. At the default this is roughly 25 MB of run ids. */
const DEFAULT_MAX = 250_000;

/**
 * Per-process memory of which runs the mirror owns, so the hot path stops asking Redis.
 *
 * The keyspace is a run's residency record and it lives in Redis, so learning that a run is NOT
 * resident used to cost a round trip, once per transition, forever. Under a brownout that is the
 * full retry budget for a question whose answer never changes.
 *
 * Soundness rests on residency being monotonic. Only a birth creates a keyspace: the append script
 * refuses `kind: "transition"` into a dead one, and the repair appends as a transition, so nothing
 * else can mint one. Therefore:
 *
 *   - `non-resident` is PERMANENT, and may be trusted to skip the network entirely.
 *   - `resident` is a hint. A keyspace can still go away under a completion expiry, a sweep, or an
 *     eviction, so a stale positive costs one round trip that returns `skippedNoKeyspace`. That is
 *     the safe direction, and it is why the cache never needs a TTL.
 *
 * There is no negative-cache invalidation and there must not be one. A run that was told it has no
 * keyspace has to keep that answer for life, or it would change stores half way through.
 */
export class ResidencyCache {
  readonly #entries: LRUCache<string, Residency>;

  constructor(options: { max?: number } = {}) {
    this.#entries = new LRUCache({ max: options.max ?? DEFAULT_MAX });
  }

  get(runId: string): Residency | undefined {
    return this.#entries.get(runId);
  }

  /** Hint only. Refused once the run is known non-resident, because that answer is final. */
  setResident(runId: string): void {
    if (this.#entries.get(runId) === "non-resident") {
      return;
    }
    this.#entries.set(runId, "resident");
  }

  setNonResident(runId: string): void {
    this.#entries.set(runId, "non-resident");
  }

  get size(): number {
    return this.#entries.size;
  }
}
