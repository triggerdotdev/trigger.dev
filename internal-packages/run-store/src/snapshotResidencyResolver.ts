import { LRUCache } from "lru-cache";
import type { StateVersionRead } from "./redisSnapshotStore.js";

// The on-demand residency resolver: resolves a runId to exactly one immutable residency answer from
// durable MemoryDB state. It is the permanent compatibility + recovery path behind the optimized
// queue-route propagation. Every durable read MUST target the MemoryDB PRIMARY (never a replica): a
// replica miss or a stale replica head cannot decide absence, residency, or the committed head. The
// injected `store` is expected to hold a primary connection.

/** The minimal MemoryDB-primary read surface the resolver needs. RedisSnapshotStore satisfies it. */
export interface SnapshotResidencyReads {
  /** The birth residency stamped on the no-TTL `res` marker, or undefined when there is no marker. */
  readBirthResidency(runId: string): Promise<string | undefined>;
  /** Run-state presence + versioned-namespace check: absent | known | unknown (unknown fails closed). */
  readStateVersion(runId: string): Promise<StateVersionRead>;
  /**
   * Pending-protocol state in one round trip: `prepared` (a prepared-but-unfinalized unit exists,
   * surfacing pendingBirth) and `quarantined` (an unresolvable unit was moved aside, so the run fails
   * closed and must never resolve to Postgres).
   */
  readPendingState(runId: string): Promise<{ prepared: boolean; quarantined: boolean }>;
}

/**
 * The five-way resolution. `committed` carries the run's immutable residency and never means postgres
 * (postgres runs have no MemoryDB birth key); `absent` maps to postgres residency; `pendingBirth` must
 * trigger commit resolution + retry at the caller; `expired` is a redis-primary run whose snapshot
 * state aged out (never an empty Postgres success); `error` is fail-closed on any read failure.
 *
 * `organizationId` is attached on a committed result WHEN a `resolveOrganizationId` is injected, so a
 * reader can dispatch on the run ORG's live dial from the cached result without another durable read.
 */
export type SnapshotResidencyResolution =
  | { kind: "committed"; residency: "mirrored" | "redis-primary"; organizationId?: string }
  | { kind: "pendingBirth" }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "error" };

/** Only committed and absent are durable + immutable enough to cache (see the design's caching rules). */
type CacheableResolution =
  | { kind: "committed"; residency: "mirrored" | "redis-primary"; organizationId?: string }
  | { kind: "absent" };

export type SnapshotResidencyResolverOptions = {
  store: SnapshotResidencyReads;
  /** Confirms the TaskRun row EXISTS, gating whether an absent result may be cached as postgres. */
  taskRunExists: (runId: string) => Promise<boolean>;
  /**
   * Resolves a committed run's organizationId from durable state, so the committed result carries the
   * org and a reader dispatches on the org's LIVE dial with no extra hot-path read (the committed
   * result is cached). Omit and a committed result carries no org (the reader reads it on demand).
   */
  resolveOrganizationId?: (runId: string) => Promise<string | undefined>;
  /** LRU bound. Fixed constant default; injectable for tests and tuning. Never an env var. */
  max?: number;
};

const DEFAULT_MAX = 250_000;

export class SnapshotResidencyResolver {
  private readonly store: SnapshotResidencyReads;
  private readonly taskRunExists: (runId: string) => Promise<boolean>;
  private readonly resolveOrganizationId?: (runId: string) => Promise<string | undefined>;
  private readonly cache: LRUCache<string, CacheableResolution>;

  constructor(options: SnapshotResidencyResolverOptions) {
    this.store = options.store;
    this.taskRunExists = options.taskRunExists;
    this.resolveOrganizationId = options.resolveOrganizationId;
    this.cache = new LRUCache<string, CacheableResolution>({ max: options.max ?? DEFAULT_MAX });
  }

  async resolve(
    runId: string,
    options?: { knownToExist?: boolean }
  ): Promise<SnapshotResidencyResolution> {
    const cached = this.cache.get(runId);
    if (cached) return cached;

    const result = await this.#resolveDurable(runId);

    if (result.kind === "committed") {
      // A finalized birth key is durable and immutable: cache immediately.
      this.cache.set(runId, result);
      return result;
    }

    if (result.kind === "absent") {
      return this.#resolveAbsent(runId, result, options?.knownToExist ?? false);
    }

    // pendingBirth, expired, and error re-resolve on every call: none is cached.
    return result;
  }

  // Cache postgres residency ONLY after both, in order: the TaskRun row EXISTS, then a SUBSEQUENT
  // primary re-read is STILL absent. Never cache absence for a nonexistent run (its Redis birth may
  // be about to prepare). A failure to confirm existence leaves the result uncached.
  //
  // `knownToExist` is set only by a caller whose PRIMARY query already returned this TaskRun row (a TTL
  // batch's findRuns): the row is known to exist, so the per-run existence probe is skipped rather than
  // repeated as a redundant Postgres query. It makes no claim that the run was locked or read inside a
  // transaction. Ordinary callers pass it false and keep the full birth-race existence guard.
  async #resolveAbsent(
    runId: string,
    first: { kind: "absent" },
    knownToExist: boolean
  ): Promise<SnapshotResidencyResolution> {
    if (!knownToExist) {
      let exists: boolean;
      try {
        exists = await this.taskRunExists(runId);
      } catch {
        return first;
      }
      if (!exists) return first;
    }

    const recheck = await this.#resolveDurable(runId);
    if (recheck.kind === "absent") {
      this.cache.set(runId, recheck);
      return recheck;
    }
    if (recheck.kind === "committed") {
      this.cache.set(runId, recheck);
    }
    return recheck;
  }

  async #resolveDurable(runId: string): Promise<SnapshotResidencyResolution> {
    let state: StateVersionRead;
    let res: string | undefined;
    try {
      [state, res] = await Promise.all([
        this.store.readStateVersion(runId),
        this.store.readBirthResidency(runId),
      ]);
    } catch {
      // A MemoryDB error is NEVER a miss.
      return { kind: "error" };
    }

    // An unknown state version fails closed, exactly like an unreadable key.
    if (state.kind === "unknown") return { kind: "error" };

    if (state.kind === "known") {
      // Committed: a live run-state keyspace. Residency comes from the birth marker; a live keyspace
      // with no valid marker is structurally invalid, so fail closed rather than guess.
      if (res === "mirrored" || res === "redis-primary") {
        // A MemoryDB error reading the org is never a miss: fail closed, exactly like the state read.
        let organizationId: string | undefined;
        if (this.resolveOrganizationId) {
          try {
            organizationId = await this.resolveOrganizationId(runId);
          } catch {
            return { kind: "error" };
          }
        }
        return {
          kind: "committed",
          residency: res,
          ...(organizationId !== undefined ? { organizationId } : {}),
        };
      }
      return { kind: "error" };
    }

    // No committed run-state. Read the pending-protocol state once. A quarantined run failed closed
    // durably: it must NEVER resolve to absent/Postgres, so it is an error exactly like an unreadable
    // key. A prepared-but-unfinalized birth is pendingBirth, distinct from a miss.
    let pending: { prepared: boolean; quarantined: boolean };
    try {
      pending = await this.store.readPendingState(runId);
    } catch {
      return { kind: "error" };
    }
    if (pending.quarantined) return { kind: "error" };
    if (pending.prepared) return { kind: "pendingBirth" };

    // Genuine miss: distinguish by the residency marker.
    if (res === undefined) return { kind: "absent" }; // clean miss -> postgres resident
    if (res === "redis-primary") return { kind: "expired" }; // marker outlived aged-out state
    if (res === "mirrored") return { kind: "absent" }; // mirrored after expiry reads Postgres
    return { kind: "error" }; // unrecognized marker: fail closed
  }
}
