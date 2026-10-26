import type { StateVersionRead } from "./redisSnapshotStore.js";

/**
 * The resolver's reads. The store must read the MemoryDB primary: a replica cannot decide absence,
 * residency or the committed head.
 */
export interface SnapshotResidencyReads {
  /** The `res` marker, or undefined. A mirrored marker expires with the run state. */
  readBirthResidency(runId: string): Promise<string | undefined>;
  readStateVersion(runId: string): Promise<StateVersionRead>;
  readPendingState(runId: string): Promise<{ prepared: boolean; quarantined: boolean }>;
}

/**
 * - `absent`: MemoryDB has nothing. This does not prove that the run is in Postgres.
 * - `pendingBirth`: the caller must resolve the pending unit, then resolve again.
 * - `expired`: a redis-primary run whose state aged out. Reads must fail, not read Postgres.
 * - `error`: fail closed.
 *
 * `organizationId` is set only when `resolveOrganizationId` is injected.
 */
export type SnapshotResidencyResolution =
  | { kind: "committed"; residency: "mirrored" | "redis-primary"; organizationId?: string }
  | { kind: "pendingBirth" }
  | { kind: "absent" }
  | { kind: "expired" }
  | { kind: "error" };

export type SnapshotResidencyResolverOptions = {
  store: SnapshotResidencyReads | (() => SnapshotResidencyReads);
  resolveOrganizationId?: (runId: string) => Promise<string | undefined>;
};

export class SnapshotResidencyResolver {
  constructor(private readonly options: SnapshotResidencyResolverOptions) {}

  private get store(): SnapshotResidencyReads {
    return typeof this.options.store === "function" ? this.options.store() : this.options.store;
  }

  resolve(runId: string): Promise<SnapshotResidencyResolution> {
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
      // A MemoryDB error is never a miss.
      return { kind: "error" };
    }

    if (state.kind === "unknown") return { kind: "error" };

    if (state.kind === "known") {
      // A live keyspace with no valid marker is invalid, so fail closed rather than guess.
      if (res === "mirrored" || res === "redis-primary") {
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

    // A quarantined run must never resolve to absent, because absent can read Postgres.
    let pending: { prepared: boolean; quarantined: boolean };
    try {
      pending = await this.store.readPendingState(runId);
    } catch {
      return { kind: "error" };
    }
    if (pending.quarantined) return { kind: "error" };
    if (pending.prepared) return { kind: "pendingBirth" };

    if (res === undefined) return { kind: "absent" };
    if (res === "redis-primary") return { kind: "expired" }; // the marker outlived the state
    if (res === "mirrored") return { kind: "absent" }; // Postgres holds the complete copy
    return { kind: "error" };
  }
}
