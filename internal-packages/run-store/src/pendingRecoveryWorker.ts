import type { PendingEntry, PendingIndex } from "./pendingIndex.js";
import type { PreparedPgUnit, RedisSnapshotStore } from "./redisSnapshotStore.js";
import { PENDING_PARTITION_COUNT } from "./snapshotKeys.js";

/** Exactly what `SELECT pg_xact_status($1::xid8)` yields on the owning primary; null = aged out. */
export type PostgresCommitStatus = "committed" | "aborted" | "in progress" | null;

export type QuarantineReason = "structurally-invalid" | "redis-primary-null" | "base-expired";

/**
 * A prepared unit's `logicalRunStoreRoute` has no owning primary mapped right now. An AVAILABILITY
 * failure, NEVER an aged-out xid or an absent commit probe: the worker RETRIES and leaves the unit
 * pending, so a committed mirrored unit is never aborted for a temporarily-missing shard mapping.
 */
export class RouteUnavailableError extends Error {
  constructor(public readonly route: string) {
    super(`snapshot recovery: no owning primary mapped for route "${route}"`);
    this.name = "RouteUnavailableError";
  }
}

/**
 * Injected dependencies. `checkPostgresCommit` / `commitProbeExists` run raw SQL on the OWNING shard's
 * Postgres PRIMARY (routed by `logicalRunStoreRoute`); this module never builds a client or reads env.
 * `halted` is accepted only to make halt-independence explicit: recovery is NEVER paused by halt, so it
 * is deliberately never consulted here.
 */
export type RecoveryDeps = {
  store: Pick<RedisSnapshotStore, "finalize" | "abortPrepared" | "readPreparedUnitRaw">;
  pendingIndex: PendingIndex;
  checkPostgresCommit: (
    xid8: string,
    logicalRunStoreRoute: string
  ) => Promise<PostgresCommitStatus>;
  commitProbeExists: (snapshotId: string, logicalRunStoreRoute: string) => Promise<boolean>;
  quarantine: (unit: PreparedPgUnit, reason: QuarantineReason, raw?: string) => Promise<void>;
  halted?: () => boolean;
};

export type RecoveryOutcome =
  | { kind: "finalized"; runId: string }
  | { kind: "aborted"; runId: string }
  // A mirrored unit whose Postgres tx committed but whose Redis base expired: the prepared Redis unit
  // is discarded (Postgres holds the complete authoritative copy). Not a failure.
  | { kind: "discarded"; runId: string; reason: "postgres-authoritative" }
  | { kind: "retry"; runId: string; reason: string }
  | { kind: "quarantined"; runId: string; reason: QuarantineReason }
  | { kind: "already-resolved"; runId: string };

/**
 * Resolves interrupted prepared transitions by their Postgres commit outcome. Consumes the per-
 * partition pending streams through the `snap-recovery` consumer group (XREADGROUP + XAUTOCLAIM), and
 * for each pending unit reads `pg_xact_status(xid8)` on the owning primary: committed -> finalize,
 * aborted -> abortPrepared, in-progress -> leave pending and retry, null -> resolve by residency
 * (mirrored via the commit-probe TRES row; redis-primary fails closed to quarantine). Ordinary
 * availability errors are retryable and NEVER quarantined. Runs in the dedicated recovery-worker role.
 */
export class PendingRecoveryWorker {
  // One in-memory XAUTOCLAIM continuation cursor per partition, advanced every pass so a large PEL is
  // swept in bounded windows rather than re-scanning the front forever. Not persisted (a fresh process
  // restarts from "0", safe for at-least-once recovery).
  readonly #cursors = new Map<number, string>();

  constructor(private readonly deps: RecoveryDeps) {}

  /**
   * Reclaim stranded entries, deliver fresh ones, and resolve each. Any outcome except `retry` is
   * ACKed (finalize/abort remove the pending unit; quarantine moves the record aside); a `retry`
   * leaves the entry pending so it is re-delivered later.
   */
  async processPartition(
    partition: number,
    consumer: string,
    opts?: { minIdleMs?: number; count?: number }
  ): Promise<RecoveryOutcome[]> {
    const minIdleMs = opts?.minIdleMs ?? 60_000;
    const count = opts?.count ?? 64;
    const startCursor = this.#cursors.get(partition) ?? "0";
    const reclaimed = await this.deps.pendingIndex.autoclaim(
      partition,
      consumer,
      minIdleMs,
      startCursor,
      count
    );
    this.#cursors.set(partition, reclaimed.cursor);
    const fresh = await this.deps.pendingIndex.readGroup(partition, consumer, count);
    const outcomes: RecoveryOutcome[] = [];
    for (const entry of [...reclaimed.entries, ...fresh]) {
      const outcome = await this.resolveEntry(entry);
      if (outcome.kind !== "retry") {
        // Atomically ACK + delete the settled entry in one op, so a crash can never leave it
        // ACKed-but-undeleted (a leaked stream member) or deleted-but-still-pending. `retry` outcomes
        // are left untouched so they redeliver.
        await this.deps.pendingIndex.settle(partition, entry.id);
      }
      outcomes.push(outcome);
    }
    return outcomes;
  }

  /** Resolve one pending entry against its Postgres commit outcome. No ACK; the caller ACKs. */
  async resolveEntry(entry: PendingEntry): Promise<RecoveryOutcome> {
    const runId = entry.fields.runId ?? "";
    const entryToken = entry.fields.transitionToken ?? "";
    if (!runId) return { kind: "already-resolved", runId };

    let raw: string | undefined;
    try {
      raw = await this.deps.store.readPreparedUnitRaw(runId);
    } catch {
      return { kind: "retry", runId, reason: "redis-unavailable" };
    }
    // The prep key is gone: a prior finalize/abort already resolved this transition.
    if (raw === undefined) return { kind: "already-resolved", runId };

    let unit: PreparedPgUnit;
    try {
      unit = JSON.parse(raw) as PreparedPgUnit;
    } catch {
      // Malformed data is quarantined immediately, preserving the RAW value for inspection, never
      // deleted-and-retried (which could misclassify a redis-primary birth). This is the ONLY place
      // that parses/validates a pending unit; the synchronous read-path resolver delegates here.
      await this.deps.quarantine(structuralStub(runId, entryToken), "structurally-invalid", raw);
      return { kind: "quarantined", runId, reason: "structurally-invalid" };
    }
    if (!isStructurallyValid(unit)) {
      await this.deps.quarantine(unit, "structurally-invalid", raw);
      return { kind: "quarantined", runId, reason: "structurally-invalid" };
    }
    // A stream entry for an older, already-resolved transition; the live unit is a newer one. The
    // synchronous read-path resolver passes NO token and resolves whatever unit is live.
    if (entryToken !== "" && unit.transitionToken !== entryToken) {
      return { kind: "already-resolved", runId };
    }

    let status: PostgresCommitStatus;
    try {
      status = await this.deps.checkPostgresCommit(unit.postgresXid, unit.logicalRunStoreRoute);
    } catch (error) {
      if (error instanceof RouteUnavailableError) {
        return { kind: "retry", runId, reason: "route-unavailable" };
      }
      return { kind: "retry", runId, reason: "pg-status-unavailable" };
    }

    if (status === "committed") return this.#finalize(unit);
    if (status === "aborted") return this.#abort(unit);
    if (status === "in progress") return { kind: "retry", runId, reason: "in-progress" };

    // null: pg_xact_status has aged out. Resolve by residency.
    if (unit.residency === "mirrored") {
      if (!unit.commitProbeSnapshotId) {
        await this.deps.quarantine(unit, "structurally-invalid");
        return { kind: "quarantined", runId, reason: "structurally-invalid" };
      }
      let present: boolean;
      try {
        present = await this.deps.commitProbeExists(
          unit.commitProbeSnapshotId,
          unit.logicalRunStoreRoute
        );
      } catch (error) {
        if (error instanceof RouteUnavailableError) {
          return { kind: "retry", runId, reason: "route-unavailable" };
        }
        return { kind: "retry", runId, reason: "commit-probe-unavailable" };
      }
      return present ? this.#finalize(unit) : this.#abort(unit);
    }

    // redis-primary has no TRES row to probe: fail closed, never guess.
    await this.deps.quarantine(unit, "redis-primary-null");
    return { kind: "quarantined", runId, reason: "redis-primary-null" };
  }

  async #finalize(unit: PreparedPgUnit): Promise<RecoveryOutcome> {
    let result;
    try {
      result = await this.deps.store.finalize(unit.runId, unit.transitionToken);
    } catch {
      return { kind: "retry", runId: unit.runId, reason: "finalize-unavailable" };
    }
    // The base keyspace expired before this delayed finalize: never rebuild a partial history. Resolve
    // by residency. Mirrored -> Postgres holds the authoritative copy, so discard the prepared Redis
    // unit and ack. Redis-primary -> no authoritative copy exists, so quarantine and fail closed.
    if (result.outcome === "baseMissing") {
      if (unit.residency === "mirrored") {
        try {
          await this.deps.store.abortPrepared(unit.runId, unit.transitionToken);
        } catch {
          return { kind: "retry", runId: unit.runId, reason: "abort-unavailable" };
        }
        return { kind: "discarded", runId: unit.runId, reason: "postgres-authoritative" };
      }
      await this.deps.quarantine(unit, "base-expired");
      return { kind: "quarantined", runId: unit.runId, reason: "base-expired" };
    }
    return { kind: "finalized", runId: unit.runId };
  }

  async #abort(unit: PreparedPgUnit): Promise<RecoveryOutcome> {
    try {
      await this.deps.store.abortPrepared(unit.runId, unit.transitionToken);
    } catch {
      return { kind: "retry", runId: unit.runId, reason: "abort-unavailable" };
    }
    return { kind: "aborted", runId: unit.runId };
  }
}

function isStructurallyValid(unit: PreparedPgUnit): boolean {
  return (
    typeof unit?.runId === "string" &&
    typeof unit?.transitionToken === "string" &&
    typeof unit?.postgresXid === "string" &&
    typeof unit?.residency === "string" &&
    typeof unit?.logicalRunStoreRoute === "string"
  );
}

function structuralStub(runId: string, transitionToken: string): PreparedPgUnit {
  return {
    protocolVersion: 0,
    transitionToken,
    postgresXid: "",
    runId,
    organizationId: "",
    residency: "",
    logicalRunStoreRoute: "",
    entries: [],
  };
}

/**
 * The bounded metric sink the sweeper feeds. Deliberately org-id-free: every signal is aggregate or
 * carries a small fixed-cardinality label, so a per-org series can never blow up the register.
 */
export interface RecoveryMetrics {
  recordOutcome(kind: RecoveryOutcome["kind"]): void;
  recordRouteUnavailable(): void;
  recordSweepLatency(ms: number): void;
  /** Set once per tick: the oldest pending unit's age and the total pending/prepared count. */
  recordPending(oldestAgeMs: number, count: number): void;
}

export type RecoverySweeperOptions = {
  worker: Pick<PendingRecoveryWorker, "processPartition">;
  pendingIndex: Pick<PendingIndex, "ensureAllGroups" | "summary">;
  /** This process's distinct consumer name, so multiple recovery pods share the load and reclaim each other. */
  consumer: string;
  partitionCount?: number;
  minIdleMs?: number;
  count?: number;
  metrics?: RecoveryMetrics;
  onPartitionError?: (partition: number, error: unknown) => void;
  /**
   * Gate a tick: return true only when this pod may scan (an enrolled cohort AND this pod holds the
   * single-fleet lease this tick). A false result does NO group or partition work, so a loser or a former
   * owner that lost the lease scans nothing. Renew the lease inside this call so it is held tick to tick.
   */
  acquireTick?: () => Promise<boolean>;
  /** Release the lease on shutdown (compare-owner), so a successor can take over promptly. */
  releaseTick?: () => Promise<void>;
};

/**
 * The dedicated recovery role's sweep loop, extracted from the boot layer so its two safety properties
 * are testable on real infra: consumer groups are ensured exactly ONCE (idempotent `ensureAllGroups`),
 * and a tick never overlaps the previous one (a running-guard, set synchronously before the first
 * await). The caller drives {@link tick} on an interval and calls {@link stop} on shutdown.
 */
export class RecoverySweeper {
  #running = false;
  #groupsEnsured = false;
  #stopped = false;

  constructor(private readonly opts: RecoverySweeperOptions) {}

  stop(): void {
    this.#stopped = true;
    void this.opts.releaseTick?.().catch(() => {});
  }

  async tick(): Promise<{ skipped: boolean; outcomes: RecoveryOutcome[] }> {
    if (this.#running || this.#stopped) return { skipped: true, outcomes: [] };
    this.#running = true;
    const started = Date.now();
    try {
      const partitionCount = this.opts.partitionCount ?? PENDING_PARTITION_COUNT;
      const outcomes: RecoveryOutcome[] = [];
      let oldestAgeMs = 0;
      let pendingCount = 0;
      let owned = false;
      const now = Date.now();
      for (let partition = 0; partition < partitionCount && !this.#stopped; partition++) {
        // Renew/verify the lease BEFORE each partition, not once for the whole scan: this HOLDS the lease
        // across a long sweep, and the instant renewal or ownership fails it stops before processing any
        // further partition. So a successor takeover can never leave two workers advancing the partitions.
        if (this.opts.acquireTick && !(await this.opts.acquireTick())) {
          return { skipped: partition === 0, outcomes };
        }
        owned = true;
        // Only a holder ever ensures the consumer groups, and only once.
        if (!this.#groupsEnsured) {
          await this.opts.pendingIndex.ensureAllGroups();
          this.#groupsEnsured = true;
        }
        try {
          const partitionOutcomes = await this.opts.worker.processPartition(
            partition,
            this.opts.consumer,
            { minIdleMs: this.opts.minIdleMs, count: this.opts.count }
          );
          for (const outcome of partitionOutcomes) {
            this.opts.metrics?.recordOutcome(outcome.kind);
            if (outcome.kind === "retry" && outcome.reason === "route-unavailable") {
              this.opts.metrics?.recordRouteUnavailable();
            }
            outcomes.push(outcome);
          }
          const summary = await this.opts.pendingIndex.summary(partition);
          pendingCount += summary.count;
          if (summary.oldestMs !== undefined) {
            oldestAgeMs = Math.max(oldestAgeMs, now - summary.oldestMs);
          }
        } catch (error) {
          this.opts.onPartitionError?.(partition, error);
        }
      }
      this.opts.metrics?.recordPending(oldestAgeMs, pendingCount);
      return { skipped: !owned, outcomes };
    } finally {
      this.opts.metrics?.recordSweepLatency(Date.now() - started);
      this.#running = false;
    }
  }
}
