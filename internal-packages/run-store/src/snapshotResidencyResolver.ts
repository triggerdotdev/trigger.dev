import type { StateVersionRead } from "./redisSnapshotStore.js";

// The on-demand residency resolver: resolves a runId to exactly one immutable residency answer from
// durable MemoryDB state when the operation has no preceding snapshot. Every durable read MUST
// target the MemoryDB PRIMARY (never a replica): a
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
 * (postgres runs have no MemoryDB birth key); `absent` proves only a MemoryDB miss; `pendingBirth` must
 * trigger commit resolution + retry at the caller; `expired` is a redis-primary run whose snapshot
 * state aged out (never an empty Postgres success); `error` is fail-closed on any read failure.
 *
 * `organizationId` is attached on a committed result WHEN a `resolveOrganizationId` is injected, so a
 * reader can dispatch on the run org's live dial without a separate organization query.
 */
export type SnapshotResidencyResolution =
  | { kind: "committed"; residency: "mirrored" | "redis-primary"; organizationId?: string }
  | { kind: "pendingBirth" }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "error" };

export type SnapshotResidencyResolverOptions = {
  store: SnapshotResidencyReads | (() => SnapshotResidencyReads);
  /** Optional durable organization lookup for callers without server context. */
  resolveOrganizationId?: (runId: string) => Promise<string | undefined>;
};

export class SnapshotResidencyResolver {
  constructor(private readonly options: SnapshotResidencyResolverOptions) {}

  private get store(): SnapshotResidencyReads {
    return typeof this.options.store === "function" ? this.options.store() : this.options.store;
  }

  resolve(runId: string): Promise<SnapshotResidencyResolution> {
    // No residency cache or TaskRun existence query. A miss proves only MemoryDB absence;
    // Postgres residency is established by the caller's existing TRES metadata.
    return this.#resolveDurable(runId);
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
        if (this.options.resolveOrganizationId) {
          try {
            organizationId = await this.options.resolveOrganizationId(runId);
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
    if (res === undefined) return { kind: "absent" }; // caller must establish a Postgres snapshot
    if (res === "redis-primary") return { kind: "expired" }; // marker outlived aged-out state
    if (res === "mirrored") return { kind: "absent" }; // mirrored after expiry reads Postgres
    return { kind: "error" }; // unrecognized marker: fail closed
  }
}
