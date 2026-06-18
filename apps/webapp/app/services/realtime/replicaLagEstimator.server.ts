import { logger } from "~/services/logger.server";

/**
 * ReplicaLagEstimator — tracks how far the read replica trails the primary so the
 * EnvChangeRouter can delay wake-path hydrates just long enough to read their own writes.
 * Two inputs: a ReplicaLagSource (active, reader-side only — never queries the primary)
 * sampled on an interval while the router is busy, and passive observations fed back by
 * the router's stale-hydrate tripwire. The estimate is the max over a short window —
 * floored by recent observations — so spikes widen the delay immediately and decay back
 * out as fresh samples land.
 */

type RawQueryable = {
  $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
};

/** A dialect-specific reader-side lag measure. `sampleLagMs()` returns the current lag in
 * ms, or undefined when lag is genuinely unmeasurable right now (NOT an error — errors
 * throw, and the composing source uses them to rule the dialect out). */
export interface ReplicaLagSource {
  readonly name: string;
  sampleLagMs(): Promise<number | undefined>;
}

/** Aurora: replicas share the storage layer and reject every standard WAL function;
 * `aurora_replica_status()` is the only live lag source. Max across readers, since the
 * `$replica` pool balances over all of them. No reader rows = `$replica` is the writer =
 * no lag. Throws on non-Aurora (the function doesn't exist). */
export class AuroraReplicaLagSource implements ReplicaLagSource {
  readonly name = "aurora";

  constructor(private readonly db: RawQueryable) {}

  async sampleLagMs(): Promise<number | undefined> {
    const rows = await this.db.$queryRawUnsafe<{ lag: number | null }[]>(
      `SELECT max(replica_lag_in_msec)::float8 AS lag FROM aurora_replica_status() WHERE session_id <> 'MASTER_SESSION_ID' AND replica_lag_in_msec IS NOT NULL`
    );
    const lag = rows[0]?.lag;
    return typeof lag === "number" && Number.isFinite(lag) ? Math.max(0, lag) : 0;
  }
}

/** Vanilla PG streaming replication. A primary (not in recovery — no replica configured,
 * `$replica` is the writer) has no lag by definition; a caught-up replica (receive LSN ==
 * replay LSN) reports 0. Mid-apply there is NO honest reader-side timestamp measure —
 * `now() - pg_last_xact_replay_timestamp()` reads as the full inter-write gap on
 * low-traffic systems, which (measured locally) pins the estimate at the delay cap — so
 * mid-apply reports undefined and the tripwire's observed-staleness floor carries the
 * estimate instead. */
export class VanillaPgReplicaLagSource implements ReplicaLagSource {
  readonly name = "vanilla-pg";

  constructor(private readonly db: RawQueryable) {}

  async sampleLagMs(): Promise<number | undefined> {
    const rows = await this.db.$queryRawUnsafe<{ caught_up: boolean | null }[]>(
      `SELECT CASE
         WHEN NOT pg_is_in_recovery() THEN true
         WHEN pg_last_wal_receive_lsn() IS NOT DISTINCT FROM pg_last_wal_replay_lsn() THEN true
         ELSE false
       END AS caught_up`
    );
    return rows[0]?.caught_up ? 0 : undefined;
  }
}

/** Composes dialect sources: the first whose sample succeeds is selected and used from
 * then on; a database where none work degrades to never-measuring (the estimator then
 * runs on its default + tripwire observations). Selection is by thrown-vs-returned —
 * sources throw on unsupported dialects and return undefined for "can't measure now". */
export class FirstSupportedReplicaLagSource implements ReplicaLagSource {
  /** undefined = not probed yet; null = no candidate works here. */
  #selected: ReplicaLagSource | null | undefined;

  constructor(private readonly candidates: ReplicaLagSource[]) {}

  get name(): string {
    return this.#selected ? this.#selected.name : "undetected";
  }

  async sampleLagMs(): Promise<number | undefined> {
    if (this.#selected === null) {
      return undefined;
    }
    if (this.#selected) {
      // Transient errors don't unselect the dialect; the sample is just skipped.
      try {
        return await this.#selected.sampleLagMs();
      } catch {
        return undefined;
      }
    }
    for (const candidate of this.candidates) {
      try {
        const lag = await candidate.sampleLagMs();
        this.#selected = candidate;
        logger.info("[replicaLagEstimator] selected lag source", { source: candidate.name });
        return lag;
      } catch {
        // unsupported dialect; try the next
      }
    }
    this.#selected = null;
    logger.warn(
      "[replicaLagEstimator] no usable lag source; relying on default + tripwire observations"
    );
    return undefined;
  }
}

/** The standard composition for a Prisma replica client. */
export function createPostgresReplicaLagSource(replica: RawQueryable): ReplicaLagSource {
  return new FirstSupportedReplicaLagSource([
    new AuroraReplicaLagSource(replica),
    new VanillaPgReplicaLagSource(replica),
  ]);
}

export type ReplicaLagEstimatorOptions = {
  source: ReplicaLagSource;
  /** Sample cadence while active. */
  sampleIntervalMs?: number;
  /** Stop sampling this long after the last touch(); the next touch resumes. */
  idleAfterMs?: number;
  /** The estimate is the max sample inside this window. */
  windowMs?: number;
  /** Estimate before any sample lands (and the floor when sampling is unavailable). */
  defaultLagMs?: number;
  /** Ceiling on accepted samples — shields the estimate from a wild observation. */
  maxLagMs?: number;
  /** How long a tripwire observation floors the estimate. Sources that can't measure
   * mid-apply lag (vanilla PG) return nothing, so without this floor the estimate decays
   * to the caught-up zeros within windowMs and every ~window one wake pays a stale retry
   * to re-learn. */
  observedFloorTtlMs?: number;
  /** Observability: a sample (active or passive) was accepted. */
  onSample?: (lagMs: number, source: "probe" | "observed") => void;
};

const DEFAULT_SAMPLE_INTERVAL_MS = 250;
const DEFAULT_IDLE_AFTER_MS = 30_000;
const DEFAULT_WINDOW_MS = 5_000;
const DEFAULT_DEFAULT_LAG_MS = 30;
const DEFAULT_MAX_LAG_MS = 60_000;
const DEFAULT_OBSERVED_FLOOR_TTL_MS = 60_000;

export class ReplicaLagEstimator {
  readonly #sampleIntervalMs: number;
  readonly #idleAfterMs: number;
  readonly #windowMs: number;
  readonly #defaultLagMs: number;
  readonly #maxLagMs: number;
  readonly #observedFloorTtlMs: number;
  #samples: { atMs: number; lagMs: number }[] = [];
  #lastKnownLagMs: number | undefined;
  #observedFloorLagMs = 0;
  #observedFloorAtMs = 0;
  #lastTouchMs = 0;
  #timer: ReturnType<typeof setInterval> | undefined;
  #sampling = false;

  constructor(private readonly options: ReplicaLagEstimatorOptions) {
    this.#sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.#idleAfterMs = options.idleAfterMs ?? DEFAULT_IDLE_AFTER_MS;
    this.#windowMs = options.windowMs ?? DEFAULT_WINDOW_MS;
    this.#defaultLagMs = options.defaultLagMs ?? DEFAULT_DEFAULT_LAG_MS;
    this.#maxLagMs = options.maxLagMs ?? DEFAULT_MAX_LAG_MS;
    this.#observedFloorTtlMs = options.observedFloorTtlMs ?? DEFAULT_OBSERVED_FLOOR_TTL_MS;
  }

  /** Mark router activity; starts (or keeps) the sampler running. */
  touch() {
    this.#lastTouchMs = Date.now();
    if (!this.#timer) {
      this.#timer = setInterval(() => this.#tick(), this.#sampleIntervalMs);
      this.#timer.unref?.();
      // Sample immediately so the first wake after idle doesn't run on a stale estimate.
      this.#tick();
    }
  }

  /** Current lag estimate (ms): the max recent sample (else last known, else the default),
   * floored by the latest tripwire observation while it's fresh. Never throws. */
  getLagMs(): number {
    const now = Date.now();
    const cutoff = now - this.#windowMs;
    let max: number | undefined;
    for (const sample of this.#samples) {
      if (sample.atMs >= cutoff && (max === undefined || sample.lagMs > max)) {
        max = sample.lagMs;
      }
    }
    const base = max ?? this.#lastKnownLagMs ?? this.#defaultLagMs;
    const floor =
      now - this.#observedFloorAtMs < this.#observedFloorTtlMs ? this.#observedFloorLagMs : 0;
    return Math.max(base, floor);
  }

  /** Feedback from the stale-hydrate tripwire: a read provably ran at least this far
   * behind the primary. Widens the estimate immediately AND floors it for a while —
   * sources that can't measure mid-apply lag would otherwise decay it straight back. */
  noteObservedLagMs(lagMs: number) {
    const clamped = Math.min(Math.max(0, lagMs), this.#maxLagMs);
    const floorExpired = Date.now() - this.#observedFloorAtMs >= this.#observedFloorTtlMs;
    if (clamped >= this.#observedFloorLagMs || floorExpired) {
      this.#observedFloorLagMs = clamped;
      this.#observedFloorAtMs = Date.now();
    }
    this.#accept(lagMs, "observed");
  }

  stop() {
    if (this.#timer) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }

  #accept(lagMs: number, source: "probe" | "observed") {
    if (!Number.isFinite(lagMs)) {
      return;
    }
    const clamped = Math.min(Math.max(0, lagMs), this.#maxLagMs);
    const now = Date.now();
    this.#samples.push({ atMs: now, lagMs: clamped });
    this.#lastKnownLagMs = clamped;
    const cutoff = now - this.#windowMs;
    while (this.#samples.length > 0 && this.#samples[0].atMs < cutoff) {
      this.#samples.shift();
    }
    this.options.onSample?.(clamped, source);
  }

  #tick() {
    if (Date.now() - this.#lastTouchMs > this.#idleAfterMs) {
      this.stop();
      return;
    }
    if (this.#sampling) {
      return; // a slow sample shouldn't stack
    }
    this.#sampling = true;
    this.options.source
      .sampleLagMs()
      .then((lagMs) => {
        if (lagMs !== undefined) {
          this.#accept(lagMs, "probe");
        }
      })
      .catch(() => {
        // sampling errors never propagate; the estimate just ages
      })
      .finally(() => {
        this.#sampling = false;
      });
  }
}
