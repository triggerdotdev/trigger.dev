import { LRUCache } from "lru-cache";

/**
 * A run's storage residency, fixed at BIRTH and unchanging for the rest of its life:
 *
 *   - `redis-only`: the run was born while its organisation's dial was at `redis-only`. Postgres
 *     holds NO snapshot rows for it — the Redis keyspace is its only home. Its snapshot writes are
 *     suppressed and a failed Redis read must NOT fall back to Postgres (Postgres is empty).
 *   - `postgres`: every other run — born off, dual-write or redis-read, and every legacy pre-cutover
 *     run. Postgres holds its full snapshot log for life, whatever the org dial does later. Its
 *     snapshot writes always land in Postgres and a failed Redis read may fall back to Postgres.
 */
export type RunRegime = "redis-only" | "postgres";

/** Entries, not bytes. Cohort-scoped: only runs the mirror has touched ever get an entry. */
const DEFAULT_MAX = 250_000;

/**
 * Per-process memory of each run's fixed residency, so the store never re-derives it from the LIVE
 * org dial. The dial governs BIRTHS only; once a run is born its regime is permanent. Re-reading the
 * dial per write/read is exactly the bug this cache removes: it strands or loses runs across dial
 * drift, long lifetimes and halt.
 *
 * Every entry is learned for free — from a birth witnessed on this process, from an append reply
 * (a `skippedNoKeyspace` proves the run is not resident, so Postgres-backed), or from a one-off
 * keyspace probe on a Redis miss. There is no DB read.
 *
 * Monotonic toward `redis-only`: a `redis-only` observation always wins, and a `postgres`
 * observation never overwrites a `redis-only` one. `redis-only` is the label that suppresses
 * Postgres and refuses a Postgres fallback, so it must never be silently downgraded by a later,
 * weaker observation (e.g. a re-entered birth after the dial moved down). An absent entry is
 * `unknown`, which defaults every decision to the safe Postgres-backed behaviour.
 */
export class RunRegimeCache {
  readonly #entries: LRUCache<string, RunRegime>;

  constructor(options: { max?: number } = {}) {
    this.#entries = new LRUCache({ max: options.max ?? DEFAULT_MAX });
  }

  get(runId: string): RunRegime | undefined {
    return this.#entries.get(runId);
  }

  /** Records a definite `redis-only` birth. Sticky: the strongest label, it always wins. */
  recordRedisOnly(runId: string): void {
    this.#entries.set(runId, "redis-only");
  }

  /**
   * Records a Postgres-backed regime, but only when the run is not already known `redis-only`. A
   * Postgres observation is the weaker one, so it must never clobber a `redis-only` label.
   */
  recordPostgres(runId: string): void {
    if (this.#entries.get(runId) === "redis-only") {
      return;
    }
    this.#entries.set(runId, "postgres");
  }

  record(runId: string, regime: RunRegime): void {
    if (regime === "redis-only") {
      this.recordRedisOnly(runId);
    } else {
      this.recordPostgres(runId);
    }
  }

  get size(): number {
    return this.#entries.size;
  }
}
