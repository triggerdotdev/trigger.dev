import {
  createRedisClient,
  type Callback,
  type RedisClient,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3/schemas";
import {
  SNAPSHOT_NAMESPACE,
  SNAPSHOT_STATE_VERSION,
  partitionTag,
  pendingStreamKeyForRun,
  preparedUnitKey,
  protocolMarkerKey,
  recoveryLeaseKey,
  residencyKey,
  runToPartition,
  snapshotKeys,
} from "./snapshotKeys.js";

/**
 * The durable quarantine key: an unresolvable prepared unit is moved aside here for an operator. It
 * shares the run's `{pNNN}` partition tag (so a partition's quarantine sits in one slot) and NEVER
 * takes a TTL — a quarantined record must stay inspectable until it is explicitly cleared.
 */
function quarantineKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:quarantine:{${partitionTag(runToPartition(runId))}}:${runId}`;
}
function quarantineKeyPrefix(partition: number): string {
  return `${SNAPSHOT_NAMESPACE}:quarantine:{${partitionTag(partition)}}:`;
}

export type QuarantinedRecord = {
  unit: PreparedPgUnit;
  reason: string;
  quarantinedAt: string;
  /** The raw, unparseable value, preserved verbatim when the unit was structurally invalid. */
  raw?: string;
};

/**
 * How a run-state keyspace answers the versioned-namespace check. `absent` is a genuine clean miss
 * (no keyspace); `known` is a state version this build understands; `unknown` FAILS CLOSED (a future
 * or missing version is never coerced into a usable head, and never treated as a Postgres-resident
 * miss).
 */
export type StateVersionRead =
  | { kind: "absent" }
  | { kind: "known" }
  | { kind: "unknown"; version: string | null };

export type CompletedWaitpointRef = { id: string; index?: number };

// Reproduces PostgresRunStore.#createExecutionSnapshot's completedWaitpointOrder derivation exactly:
// drop anything without an index, sort ascending by index, map to id. Repeats are preserved, because
// the same run can sit in one batch more than once under a single idempotency key.
export function deriveOrder(completedWaitpoints: CompletedWaitpointRef[]): string[] {
  return completedWaitpoints
    .filter((w) => w.index !== undefined)
    .sort((a, b) => a.index! - b.index!)
    .map((w) => w.id);
}

/**
 * The COMPLETE distinct set of completed-waitpoint ids, including those with no batch index.
 *
 * This is deliberately not `deriveOrder` deduped. `order` is the index oracle and carries only
 * batch-indexed ids, because its positions ARE the indexes. A wait with no batch index (every
 * `wait.for`, every single `triggerAndWait`, every token) has no position and is absent from it,
 * while Postgres records it in the completed-waitpoint join like any other. Reading the id set back
 * from `order` therefore loses exactly those waits, and a run resumed from Redis loses their results.
 */
export function deriveDistinctIds(completedWaitpoints: CompletedWaitpointRef[]): string[] {
  return [...new Set(completedWaitpoints.map((w) => w.id))];
}

// isValid is derived, never stored, so the entry JSON stays byte-identical to the caller's document.
export function isValidFor(entry: { error?: unknown }): boolean {
  return !entry.error;
}

// ---------------------------------------------------------------------------
// The completed-waitpoints freeze. Frozen jointly with the waitpoint lane.
// Do not change a field here without re-agreeing the contract with that lane.
// ---------------------------------------------------------------------------

/**
 * The once-per-wait-cycle pointer. `cycleSeq` names the snap:{runId}:wp:<cycleSeq>
 * key. `count` is order.length -- NOT the record count -- so it is zero for any
 * wait that carries no batch index.
 */
export type CompletedWaitpointsPointer = {
  cycleSeq: number;
  count: number;
};

/**
 * A record's output.
 * - `inline` holds the literal value. MANUAL and DATETIME are bounded by the offload
 *   thresholds; error outputs are not (only BUILT_IN_ERROR truncates), so the bound is
 *   the completion body limit. Postgres holds the same strings, so this is a copy.
 * - `ref` holds an application/store reference that was already offloaded.
 * - `deriveFromRun` means the resolver reads TaskRun.output for completedByTaskRunId.
 *   Only a RUN record with outputIsError false AND a non-null completedByTaskRunId uses
 *   it: TaskRun.output is a String column holding the same string verbatim, so the
 *   re-read is byte-identical. A RUN error cannot use it, because TaskRun.error is
 *   jsonb and never round-trips. Waitpoint.completedByTaskRun is onDelete: SetNull, so
 *   an orphaned RUN waitpoint (the completing run row was deleted) has no run left to
 *   derive from -- its output carries inline instead.
 */
export type CompletedWaitpointRecordOutput =
  | { inline: string }
  | { ref: string }
  | { deriveFromRun: true }
  | null;

/**
 * One completed waitpoint, one per DISTINCT id in a wait cycle. The resolver expands
 * this into one CompletedWaitpoint per position of the id in the cycle's order list.
 */
export type CompletedWaitpointRecord = {
  id: string;
  friendlyId: string;
  type: "RUN" | "BATCH" | "DATETIME" | "MANUAL";
  /** ISO. The writer pins it, applying the null fallback once. */
  completedAt: string;
  /** Defaults to "application/json" at source. */
  outputType: string;
  outputIsError: boolean;
  output: CompletedWaitpointRecordOutput;
  /** RUN. The resolver derives friendlyId, and batch{} from the READING entry's batchId. */
  completedByTaskRunId?: string;
  /** BATCH. The resolver derives friendlyId. */
  completedByBatchId?: string;
  /** ISO. Any type may set it: a MANUAL waitpoint with a timeout does. */
  completedAfter?: string;
  /** Already resolved: userProvidedIdempotencyKey && !inactiveIdempotencyKey. */
  idempotencyKey?: string;
};

/**
 * What the store hands the resolver. The store owns the keyspace, so the store reads
 * and parses the cycle hash. The resolver never touches Redis and never derives a key.
 */
export type ResolveCompletedWaitpointsArgs = {
  runId: string;
  /** The batchId of the entry being READ, never the entry that minted the cycle. */
  batchId?: string;
  pointer: CompletedWaitpointsPointer;
  /** Index oracle only. A SUBSET of the record ids. Repeats preserved. */
  order: string[];
  /** The authoritative, complete set. Iterate this, never `order`. */
  records: CompletedWaitpointRecord[];
};

/**
 * This lane owns the signature. The waitpoint lane owns the implementation, which
 * lives in run-engine because a deriveFromRun record needs a Postgres read.
 */
export type CompletedWaitpointResolver = (
  args: ResolveCompletedWaitpointsArgs
) => Promise<CompletedWaitpoint[]>;

export type SnapshotEntryInput = {
  id: string;
  engine: "V2";
  executionStatus: string;
  description: string;
  runId: string;
  runStatus: string;
  createdAt: string;
  attemptNumber?: number | null;
  previousSnapshotId?: string;
  batchId?: string;
  environmentId: string;
  environmentType: string;
  projectId: string;
  organizationId: string;
  checkpointId?: string;
  workerId?: string;
  runnerId?: string;
  metadata?: unknown;
  error?: string;
  /**
   * RESERVED. Always unset. `append` rejects a set value.
   *
   * The pointer's physical form is the `<snapshotId>#c` sidecar field on the `e` hash,
   * because the append Lua mints both halves after the client serializes the entry.
   * The entry JSON must stay byte-identical to the caller's document, and the Postgres
   * snapshot row has no pointer column, so a pointer inside the JSON would stop the two
   * documents from being comparable for the dual-write comparator.
   */
  completedWaitpoints?: CompletedWaitpointsPointer;
};

export type WaitpointIds = { present: boolean; distinctIds: string[]; order: string[] };

/**
 * A snapshot's completed-waitpoint cycle, records included, read for a redis-primary reproduction of
 * a Postgres read. `present` is false for a snapshot the keyspace does not hold; `danglingCycle` is a
 * pointer whose cycle key is gone, so its waitpoints are UNREACHABLE (a redis-primary read fails
 * closed rather than treating that as an empty set).
 */
export type CompletedWaitpointsRead = {
  present: boolean;
  danglingCycle: boolean;
  distinctIds: string[];
  order: string[];
  records: CompletedWaitpointRecord[];
};

export type GetSinceResult =
  | { kind: "miss" }
  | { kind: "hit"; entries: SnapshotRead[]; headWaitpointIds: WaitpointIds };

export type SnapshotRead = {
  id: string;
  seq: number;
  isValid: boolean;
  entry: Record<string, unknown>;
  raw: string;
  cycle?: CompletedWaitpointsPointer;
  completedWaitpointIds?: WaitpointIds;
  /**
   * The entry points at a cycle key that no longer exists, so its waitpoints are unreachable rather
   * than absent. A caller must not treat this as an empty set: it has to fall back to Postgres,
   * which still holds the join rows.
   */
  danglingCycle?: boolean;
};

export type AppendResult =
  | {
      outcome: "written";
      seq: number;
      cycleSeq?: number;
      ttl: "none" | "completion" | "reapplied";
      cycleMismatch: boolean;
    }
  | { outcome: "skippedNoKeyspace" }
  | { outcome: "forked"; actualCur: string }
  | { outcome: "duplicate"; seq: number };

/** The single source of truth for the outcome vocabulary the metrics layer bounds against. */
export const APPEND_RESULT_OUTCOMES = [
  "written",
  "skippedNoKeyspace",
  "forked",
  "duplicate",
] as const satisfies readonly AppendResult["outcome"][];

/**
 * `satisfies` alone only proves each listed literal is a valid outcome. This proves the reverse too,
 * so a new member on AppendResult fails the build here rather than becoming "other" on a dashboard.
 */
type AssertSameOutcomes<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _outcomesExhaustive: AssertSameOutcomes<
  (typeof APPEND_RESULT_OUTCOMES)[number],
  AppendResult["outcome"]
> = true;
void _outcomesExhaustive;

/**
 * The append cycle payload: the completed-waitpoint REFERENCES plus the full record set that let a
 * redis-primary read reproduce a Postgres read. Reused verbatim by {@link RedisSnapshotStore.append}
 * and by a staged {@link PreparedEntry}; extracted so the prepared unit reuses the real type rather
 * than inventing one.
 */
export type AppendCyclePayload =
  | {
      kind: "new";
      completedWaitpoints: CompletedWaitpointRef[];
      records?: CompletedWaitpointRecord[];
    }
  | {
      kind: "carryForward";
      cycleSeq: number;
      completedWaitpoints?: CompletedWaitpointRef[];
      records?: CompletedWaitpointRecord[];
    };

/**
 * One staged append inside a transaction-sized prepared unit. It is exactly what a single
 * {@link RedisSnapshotStore.append} call takes: the snapshot document, the birth/transition `kind`
 * and terminal flag the append already requires, the optional EXISTING fork guard, and the optional
 * EXISTING cycle payload. No new versioning model (`head`/`output`/`previousHeadVersion`) is invented.
 */
export type PreparedEntry = {
  entry: SnapshotEntryInput;
  kind: "birth" | "transition";
  isTerminal: boolean;
  /** The existing optional fork guard: the head snapshotId this append asserts, or "" for unset. */
  expectedCur?: string;
  cycle?: AppendCyclePayload;
};

/**
 * The durable prepared transaction unit MemoryDB holds between an owning Postgres transaction's
 * prepare and its finalize. Transaction-sized: one per owning transaction, holding the ORDERED
 * snapshot entries the transaction produces. Stored hidden at {@link preparedUnitKey}; its entries
 * are invisible to reads until {@link RedisSnapshotStore.finalize} publishes the whole unit at once.
 */
export type PreparedPgUnit = {
  protocolVersion: number;
  transitionToken: string;
  /** The owning Postgres transaction's xid8, as a string. Consumed by the M4 recovery worker. */
  postgresXid: string;
  runId: string;
  organizationId: string;
  residency: string;
  /** The stable LOGICAL run-store route; never a connection string or physical host. */
  logicalRunStoreRoute: string;
  entries: PreparedEntry[];
  /** MIRRORED only: an entry.id of the SAME transaction, point-read on the owning primary in M4. */
  commitProbeSnapshotId?: string;
};

export type PrepareResult =
  | { outcome: "prepared"; streamId: string }
  | { outcome: "idempotent"; streamId: string }
  | { outcome: "busy" }
  | { outcome: "conflict" }
  | { outcome: "forkGuard"; reason: "head"; actualCur: string }
  | { outcome: "forkGuard"; reason: "chain"; index: number };

export type FinalizeResult =
  | { outcome: "finalized"; head: string }
  | { outcome: "noop" }
  | { outcome: "stale" }
  // A non-birth unit whose base keyspace expired or is version-incompatible: nothing was applied and
  // the prep + pending record are preserved for recovery to choose a safe disposition (never a partial
  // rebuild). See finalizeSnapshotUnit's base guard and PendingRecoveryWorker.
  | { outcome: "baseMissing" };

export type AbortPreparedResult =
  | { outcome: "aborted" }
  | { outcome: "noop" }
  | { outcome: "stale" };

// The precomputed per-entry apply payload the finalize Lua consumes. Derived from a PreparedEntry the
// same way append() derives its ARGV, so a finalized entry is byte-identical to the same append().
type StagedApply = {
  kind: "birth" | "transition";
  id: string;
  raw: string;
  valid: boolean;
  isTerminal: boolean;
  cycleMode: string;
  cycleSeqIn: number;
  orderJson: string;
  records: string;
  orderCount: string;
  distinctJson: string;
  birthMode: string;
};

export type SnapshotStoreMetrics = {
  recordAppend(outcome: string, ttl: string, organizationId?: string): void;
  recordEntryBytes(bytes: number): void;
  recordCycleKeyBytes(bytes: number): void;
  recordCycleCount(count: number): void;
  recordSkippedNoKeyspace(): void;
  recordCycleMismatch(): void;
  recordLatency(op: string, ms: number): void;
};

/**
 * How the store reaches Redis. Exactly one of the two, enforced by the type rather than a runtime
 * check: `never` on the opposite member makes both "neither" and "both" a compile error.
 *
 * `client` exists because production points at a Valkey/Redis CLUSTER, and cluster topology is not
 * this package's business. Every command the store issues is key-addressed and every key carries a
 * `{runId}` hashtag, so one slot serves a whole run and both endpoint shapes behave identically.
 * A caller-supplied client is owned by the caller: `quit()` leaves it open.
 */
export type RedisSnapshotStoreConnection =
  | { client: RedisClient; redisOptions?: never }
  | { client?: never; redisOptions: RedisOptions };

export type RedisSnapshotStoreOptions = RedisSnapshotStoreConnection & {
  completedTtlMs: number;
  sinceLimit?: number;
  highWater?: { entryBytes?: number; cycleKeyBytes?: number; cycleCount?: number };
  metrics?: SnapshotStoreMetrics;
  logger?: Logger;
};

/**
 * Both window scripts return four leading slots before the first row: the id-cursor variant's
 * `sinceRaw`, the head's order, the head's distinct set, and the head's dangling flag. Rows follow
 * in four-element groups, so the head row is the group at this offset.
 *
 * Named because the offset drifted out of the comments describing it twice, and the second drift
 * arrived in the change that fixed the first.
 */
const WINDOW_HEAD_ROW_INDEX = 4;

const SKIPPED = "skipped";
const FORKED = "forked";
const WRITTEN = "written";
const DUPLICATE = "duplicate";

export class RedisSnapshotStore {
  private readonly redis: RedisClient;
  /** Only a client this class opened may be closed by it. */
  private readonly ownsClient: boolean;
  private readonly logger: Logger;
  private readonly completedTtlMs: number;
  private readonly sinceLimit: number;
  private readonly metrics?: SnapshotStoreMetrics;
  private readonly highWater: NonNullable<RedisSnapshotStoreOptions["highWater"]>;
  #quit?: Promise<void>;

  constructor(options: RedisSnapshotStoreOptions) {
    this.logger = options.logger ?? new Logger("RedisSnapshotStore", "debug");
    this.completedTtlMs = options.completedTtlMs;
    this.sinceLimit = options.sinceLimit ?? 50;
    this.metrics = options.metrics;
    this.highWater = options.highWater ?? {};
    this.ownsClient = options.client === undefined;
    this.redis =
      options.client ??
      createRedisClient(options.redisOptions, {
        onError: (error) => this.logger.error("RedisSnapshotStore redis client error", { error }),
      });
    this.#registerCommands();
  }

  async quit(): Promise<void> {
    // Idempotent and error-swallowing: every test calls this in a `finally`, and a double quit()
    // (or one after a failed connect) must never mask the real assertion failure.
    //
    // An injected client is the caller's. Closing it here would take down a connection shared with
    // the sweeper or with another component, so a borrowed client is left open.
    if (!this.ownsClient) return;
    if (!this.#quit) {
      this.#quit = this.redis.quit().then(
        () => undefined,
        () => undefined
      );
    }
    await this.#quit;
  }

  /** Every command goes through here so latency is recorded on one seam rather than each method. */
  async #timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.metrics?.recordLatency(op, Date.now() - started);
    }
  }

  /**
   * Records that this run's Redis history has a hole, so window reads must not serve it. Separate
   * from the append path because a repair can conclude the head is already current and still know
   * that entries were lost.
   */
  async markGaps(runId: string): Promise<void> {
    await this.redis.hset(snapshotKeys(runId).seq, "g", "1");
  }

  /**
   * Marks only a keyspace that exists, and reports whether it did.
   *
   * The unconditional form must not be used on a run whose residency is unknown: HSET creates the
   * hash, so a non-resident run would be left holding a lone `seq` key with nothing but the marker.
   * `keyspaceAlive` would stay false so no read would be affected, but the sweeper discovers
   * keyspaces by scanning for the ENTRY hash, so it would never find that key either. An unbounded
   * leak with no reader is the one outcome worse than the hole this marker exists to report.
   */
  async markGapsIfResident(runId: string): Promise<boolean> {
    const k = snapshotKeys(runId);
    return this.#timed("markGapsIfResident", async () => {
      const marked = await this.redis.markSnapshotGaps(k.e, k.seq);
      return marked === 1;
    });
  }

  async hasGaps(runId: string): Promise<boolean> {
    return (await this.redis.hget(snapshotKeys(runId).seq, "g")) === "1";
  }

  /**
   * The run's birth residency, stamped on the no-TTL residency key at birth (see {@link append}).
   * Returns the residency string, or `undefined` when the run is not resident. It is the residency
   * probe a process uses on a Redis miss to decide, WITHOUT a Postgres read, whether a `redis-only`
   * run's read may fall back to Postgres (it may not). The marker outlives the run-state keys once
   * they take the terminal TTL, so an expired redis-primary run stays distinguishable from a
   * Postgres-resident one.
   */
  async readBirthResidency(runId: string): Promise<string | undefined> {
    const mode = await this.#timed("readBirthResidency", () => this.redis.get(residencyKey(runId)));
    return mode ?? undefined;
  }

  /**
   * The committed run's organizationId, taken from its finalized head entry (organizationId is a scalar
   * on every entry). Undefined when the run holds no visible head. It is the durable source a residency
   * resolver uses to attach the org to a committed result so a read dispatches on the org's live dial.
   */
  async readCommittedOrganizationId(runId: string): Promise<string | undefined> {
    const head = await this.getLatest(runId);
    const organizationId = (head?.entry as { organizationId?: unknown } | undefined)
      ?.organizationId;
    return typeof organizationId === "string" ? organizationId : undefined;
  }

  /**
   * Whether a prepared-but-unfinalized unit exists for this run. The residency resolver uses it to
   * surface `pendingBirth` (a birth prepared but not yet finalized) distinctly from a clean miss.
   * Reads the MemoryDB PRIMARY; the prep key is removed on finalize/abort, so its presence is exactly
   * "a unit is pending".
   */
  async hasPreparedUnit(runId: string): Promise<boolean> {
    return this.#timed("hasPreparedUnit", async () => {
      return (await this.redis.exists(preparedUnitKey(runId))) === 1;
    });
  }

  /**
   * The raw stored {@link PreparedPgUnit} JSON, or undefined when nothing is pending. The recovery
   * worker parses it itself so a corrupt payload is a STRUCTURAL error it can quarantine, kept
   * distinct from a Redis availability error (which is retryable). Reads the MemoryDB PRIMARY.
   */
  async readPreparedUnitRaw(runId: string): Promise<string | undefined> {
    return this.#timed("readPreparedUnitRaw", async () => {
      const raw = await this.redis.hget(preparedUnitKey(runId), "unit");
      return raw ?? undefined;
    });
  }

  /**
   * Persist an unresolvable prepared unit to its durable quarantine key BEFORE the caller ACKs the
   * pending stream entry, so a quarantined unit is recoverable/inspectable by an operator (log + ACK
   * alone would lose it). No TTL: the record outlives every run-state key. Idempotent per run.
   */
  async quarantinePreparedUnit(unit: PreparedPgUnit, reason: string, raw?: string): Promise<void> {
    await this.#timed("quarantinePreparedUnit", async () => {
      await this.redis.hset(
        quarantineKey(unit.runId),
        "unit",
        JSON.stringify(unit),
        "reason",
        reason,
        "quarantinedAt",
        new Date().toISOString(),
        // The RAW malformed value, preserved verbatim for inspection when the unit could not be parsed.
        ...(raw !== undefined ? (["raw", raw] as const) : ([] as const))
      );
    });
  }

  /** The quarantined record for a run, or undefined when none. Reads the MemoryDB PRIMARY. */
  async readQuarantinedUnit(runId: string): Promise<QuarantinedRecord | undefined> {
    return this.#timed("readQuarantinedUnit", async () => {
      const fields = (await this.redis.hgetall(quarantineKey(runId))) as Record<string, string>;
      const raw = fields.unit;
      if (!raw) return undefined;
      return {
        unit: JSON.parse(raw) as PreparedPgUnit,
        reason: fields.reason ?? "",
        quarantinedAt: fields.quarantinedAt ?? "",
        ...(fields.raw !== undefined ? { raw: fields.raw } : {}),
      };
    });
  }

  /**
   * Enumerate the run ids with a quarantined unit in a partition, so an operator (or a bounded metric)
   * can discover them. SCANs the partition's quarantine keyspace on every master node; used off the hot
   * path only.
   */
  async listQuarantinedRunIds(partition: number): Promise<string[]> {
    const pattern = `${quarantineKeyPrefix(partition)}*`;
    const runIds: string[] = [];
    const scanNode = async (node: RedisClient): Promise<void> => {
      let cursor = "0";
      do {
        const [next, keys] = (await node.scan(cursor, "MATCH", pattern, "COUNT", 100)) as [
          string,
          string[],
        ];
        cursor = next;
        for (const key of keys) runIds.push(key.slice(key.lastIndexOf(":") + 1));
      } while (cursor !== "0");
    };
    const maybeCluster = this.redis as unknown as { nodes?: (role: "master") => RedisClient[] };
    if (typeof maybeCluster.nodes === "function") {
      for (const node of maybeCluster.nodes("master")) await scanNode(node);
    } else {
      await scanNode(this.redis);
    }
    return runIds;
  }

  /**
   * The Redis `maxmemory-policy`, for the redis-primary no-eviction readiness probe. Prepared, pending,
   * active and quarantine records MUST never expire, so anything but `noeviction` is unsafe for
   * redis-primary. Returns undefined when the policy cannot be read (the caller fails closed).
   */
  async readMaxMemoryPolicy(): Promise<string | undefined> {
    try {
      const reply = (await this.redis.call("CONFIG", "GET", "maxmemory-policy")) as
        | string[]
        | undefined;
      if (Array.isArray(reply)) return reply[1];
      return undefined;
    } catch {
      return undefined;
    }
  }

  // The single-fleet recovery lease. Acquire when absent, renew when we already own it, refuse when
  // another pod owns it: one atomic script per tick so no pod can renew another pod's lease.
  async acquireOrRenewRecoveryLease(owner: string, ttlMs: number): Promise<boolean> {
    const result = (await this.redis.eval(
      `local cur = redis.call('GET', KEYS[1])
       if cur == false then redis.call('SET', KEYS[1], ARGV[1], 'PX', tonumber(ARGV[2])); return 1
       elseif cur == ARGV[1] then redis.call('PEXPIRE', KEYS[1], ARGV[2]); return 1
       else return 0 end`,
      1,
      recoveryLeaseKey(),
      owner,
      String(ttlMs)
    )) as number;
    return result === 1;
  }

  // Release only if we still own it (compare-owner): a former owner can never delete a successor's lease.
  async releaseRecoveryLease(owner: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
      1,
      recoveryLeaseKey(),
      owner
    );
  }

  /**
   * The durable namespace/protocol preflight. Bootstraps the marker to `validatedVersion` ONLY when
   * absent (atomic SET NX), then returns the stored value: redis-primary is compatible iff it exactly
   * matches. A Redis error throws so the caller fails closed.
   */
  async readOrBootstrapProtocolMarker(
    validatedVersion: string
  ): Promise<{ compatible: boolean; stored: string }> {
    const stored = (await this.redis.eval(
      `local cur = redis.call('GET', KEYS[1])
       if cur == false then redis.call('SET', KEYS[1], ARGV[1], 'NX'); cur = redis.call('GET', KEYS[1]) end
       return cur`,
      1,
      protocolMarkerKey(),
      validatedVersion
    )) as string;
    return { compatible: stored === validatedVersion, stored };
  }

  /**
   * Classify the run-state keyspace against the versioned namespace. The seam the residency resolver
   * uses to FAIL CLOSED: a keyspace whose `stateVersion` this build does not understand (or that is
   * missing while the keyspace exists) is `unknown`, never a clean miss.
   */
  async readStateVersion(runId: string): Promise<StateVersionRead> {
    return this.#timed("readStateVersion", async () => {
      const k = snapshotKeys(runId);
      const [exists, sv] = (await this.redis.multi().exists(k.seq).hget(k.seq, "sv").exec()) as [
        [Error | null, number],
        [Error | null, string | null],
      ];
      if ((exists[1] ?? 0) === 0) return { kind: "absent" };
      const version = sv[1] ?? null;
      if (version === SNAPSHOT_STATE_VERSION) return { kind: "known" };
      return { kind: "unknown", version };
    });
  }

  /**
   * Removes a run's whole keyspace, wait-cycle keys included. The caller must have established that
   * the head cannot be trusted and that Postgres still holds the run's rows.
   */
  async dropRun(runId: string): Promise<void> {
    const keys = snapshotKeys(runId);
    await this.redis.dropSnapshotRun(keys.e, keys.idx, keys.cur, keys.seq);
  }

  async append(args: {
    entry: SnapshotEntryInput;
    kind: "birth" | "transition";
    isTerminal: boolean;
    expectedCur?: string;
    /**
     * The run's residency, stamped into the keyspace on a BIRTH and never afterwards. It is the ONE
     * durable record of whether a run was born `redis-only` (Postgres holds nothing) or Postgres-
     * backed, so a process that did not witness the birth can learn the run's fixed residency from a
     * cheap {@link readBirthResidency} probe instead of the live org dial or a Postgres read. Ignored
     * for a transition. Absent leaves the residency marker unwritten.
     */
    birthMode?: string;
    /**
     * Marks the keyspace as holed, so window reads refuse and fall back to Postgres. Set by the
     * repair, which only runs because an append was lost.
     */
    markGaps?: boolean;
    // A carry the store refuses falls back to minting inside the same call from the refs a `new`
    // cycle would carry; with no refs there is nothing to mint from, so the entry is written with no
    // pointer, as before. Every production caller supplies them; omitting them gives up the fallback.
    cycle?: AppendCyclePayload;
  }): Promise<AppendResult> {
    if (args.entry.completedWaitpoints !== undefined) {
      throw new Error(
        "completedWaitpoints is a reserved entry field and must stay unset. The pointer's " +
          "physical form is the `<snapshotId>#c` sidecar field, which the append script mints. " +
          "Writing it into the entry JSON breaks byte-comparability with the Postgres row."
      );
    }
    return this.#timed("append", async () => {
      const k = snapshotKeys(args.entry.runId);
      const raw = JSON.stringify(args.entry);
      const valid = isValidFor(args.entry);

      let cycleMode = "none";
      let cycleSeqIn = "0";
      let orderJson = "";
      let distinctJson = "";
      let records = "";
      let orderCount = "0";
      if (args.cycle?.kind === "new") {
        const order = deriveOrder(args.cycle.completedWaitpoints);
        cycleMode = "new";
        orderJson = JSON.stringify(order);
        distinctJson = JSON.stringify(deriveDistinctIds(args.cycle.completedWaitpoints));
        records = args.cycle.records ? JSON.stringify(args.cycle.records) : "";
        orderCount = String(order.length);
      } else if (args.cycle?.kind === "carryForward") {
        cycleMode = "carry";
        cycleSeqIn = String(args.cycle.cycleSeq);

        // Carried for the refusal path only. The script uses these solely when it declines the
        // pointer and mints a replacement, and can only do that when the caller supplied them.
        if (args.cycle.completedWaitpoints) {
          const order = deriveOrder(args.cycle.completedWaitpoints);
          orderJson = JSON.stringify(order);
          records = args.cycle.records ? JSON.stringify(args.cycle.records) : "";
          orderCount = String(order.length);
          distinctJson = JSON.stringify(deriveDistinctIds(args.cycle.completedWaitpoints));
        }
      }

      const reply = (await this.redis.appendSnapshotEntry(
        k.e,
        k.idx,
        k.cur,
        k.seq,
        residencyKey(args.entry.runId),
        args.kind,
        args.entry.id,
        raw,
        valid ? "1" : "0",
        args.isTerminal ? "1" : "0",
        String(this.completedTtlMs),
        cycleMode,
        cycleSeqIn,
        orderJson,
        records,
        orderCount,
        args.expectedCur ?? "",
        args.expectedCur !== undefined ? "1" : "0",
        distinctJson,
        args.markGaps ? "1" : "0",
        args.kind === "birth" ? (args.birthMode ?? "") : ""
      )) as string[];

      return this.#interpretAppend(
        reply,
        raw,
        orderJson,
        records,
        args.entry.runId,
        args.entry.organizationId
      );
    });
  }

  #interpretAppend(
    reply: string[],
    raw: string,
    orderJson: string,
    records: string,
    runId: string,
    organizationId: string
  ): AppendResult {
    if (reply[0] === SKIPPED) {
      // Authoritative and final: the script looked and there is no keyspace. Only a birth could
      // create one and this run's birth has already happened. No keyspace means Postgres-backed.
      this.metrics?.recordSkippedNoKeyspace();
      this.metrics?.recordAppend("skippedNoKeyspace", "none", organizationId);
      return { outcome: "skippedNoKeyspace" };
    }
    if (reply[0] === FORKED) {
      this.metrics?.recordAppend("forked", "none", organizationId);
      return { outcome: "forked", actualCur: reply[1] ?? "" };
    }
    if (reply[0] === DUPLICATE) {
      this.metrics?.recordAppend("duplicate", "none", organizationId);
      return { outcome: "duplicate", seq: Number(reply[1]) };
    }
    const seq = Number(reply[1]);
    const cycleSeq = Number(reply[2]);
    const ttl = reply[3] as "none" | "completion" | "reapplied";
    const cycleMismatch = reply[4] === "1";
    if (cycleMismatch) {
      this.metrics?.recordCycleMismatch();
    }
    this.#observeSizes(raw, orderJson, records, cycleSeq, runId);
    this.metrics?.recordAppend("written", ttl, organizationId);
    return {
      outcome: "written",
      seq,
      ...(cycleSeq > 0 ? { cycleSeq } : {}),
      ttl,
      cycleMismatch,
    };
  }

  #observeSizes(
    raw: string,
    orderJson: string,
    records: string,
    cycleSeq: number,
    runId: string
  ): void {
    const entryBytes = Buffer.byteLength(raw, "utf8");
    this.metrics?.recordEntryBytes(entryBytes);
    if (this.highWater.entryBytes !== undefined && entryBytes > this.highWater.entryBytes) {
      this.logger.warn("RedisSnapshotStore entry above high-water mark", { runId, entryBytes });
    }
    if (orderJson !== "") {
      // The whole wp:<cycleSeq> key, not just its order field: records dominates it once populated.
      const cycleBytes = Buffer.byteLength(orderJson, "utf8") + Buffer.byteLength(records, "utf8");
      this.metrics?.recordCycleKeyBytes(cycleBytes);
      if (this.highWater.cycleKeyBytes !== undefined && cycleBytes > this.highWater.cycleKeyBytes) {
        this.logger.warn("RedisSnapshotStore cycle key above high-water mark", {
          runId,
          cycleBytes,
        });
      }
    }
    if (cycleSeq > 0) {
      this.metrics?.recordCycleCount(cycleSeq);
      if (this.highWater.cycleCount !== undefined && cycleSeq > this.highWater.cycleCount) {
        this.logger.warn("RedisSnapshotStore cycle count above high-water mark", {
          runId,
          cycleSeq,
        });
      }
    }
  }

  // Derive one entry's apply payload the same way append() derives its ARGV, so a finalized staged
  // entry lands byte-identically to the same append() call. Residency stamps the birth's res marker.
  #stageEntry(pe: PreparedEntry, residency: string): StagedApply {
    if (pe.entry.completedWaitpoints !== undefined) {
      throw new Error(
        "completedWaitpoints is a reserved entry field and must stay unset on a prepared entry."
      );
    }
    let cycleMode = "none";
    let cycleSeqIn = 0;
    let orderJson = "";
    let distinctJson = "";
    let records = "";
    let orderCount = "0";
    if (pe.cycle?.kind === "new") {
      const order = deriveOrder(pe.cycle.completedWaitpoints);
      cycleMode = "new";
      orderJson = JSON.stringify(order);
      distinctJson = JSON.stringify(deriveDistinctIds(pe.cycle.completedWaitpoints));
      records = pe.cycle.records ? JSON.stringify(pe.cycle.records) : "";
      orderCount = String(order.length);
    } else if (pe.cycle?.kind === "carryForward") {
      cycleMode = "carry";
      cycleSeqIn = pe.cycle.cycleSeq;
      if (pe.cycle.completedWaitpoints) {
        const order = deriveOrder(pe.cycle.completedWaitpoints);
        orderJson = JSON.stringify(order);
        records = pe.cycle.records ? JSON.stringify(pe.cycle.records) : "";
        orderCount = String(order.length);
        distinctJson = JSON.stringify(deriveDistinctIds(pe.cycle.completedWaitpoints));
      }
    }
    return {
      kind: pe.kind,
      id: pe.entry.id,
      raw: JSON.stringify(pe.entry),
      valid: isValidFor(pe.entry),
      isTerminal: pe.isTerminal,
      cycleMode,
      cycleSeqIn,
      orderJson,
      records,
      orderCount,
      distinctJson,
      birthMode: pe.kind === "birth" ? residency : "",
    };
  }

  /**
   * Atomically stage a transaction-sized {@link PreparedPgUnit}: store the hidden unit + its ordered
   * staged entries at {@link preparedUnitKey}, and XADD one pending-index entry to the run's partition
   * stream. The staged entries are NOT written to the run keyspace, so reads never see them until
   * {@link finalize}. Only ONE pending unit per run: a DIFFERENT token while one is pending is `busy`;
   * the SAME token with an identical unit is `idempotent` (lost-reply-safe); the SAME token with
   * different data is a `conflict`. The batch fork guard reproduces sequential append: the first
   * guarded entry asserts the committed head (checked in Lua), each subsequent guarded entry asserts
   * its predecessor's staged id (checked here); a broken chain is rejected.
   */
  async prepare(unit: PreparedPgUnit): Promise<PrepareResult> {
    return this.#timed("prepare", async () => {
      const { runId } = unit;
      for (const pe of unit.entries) {
        if (pe.entry.runId !== runId) {
          throw new Error("A PreparedPgUnit must contain exactly one run");
        }
      }
      for (let i = 1; i < unit.entries.length; i++) {
        const guard = unit.entries[i].expectedCur;
        if (guard !== undefined && guard !== unit.entries[i - 1].entry.id) {
          return { outcome: "forkGuard", reason: "chain", index: i };
        }
      }
      const staged = unit.entries.map((pe) => this.#stageEntry(pe, unit.residency));
      const first = unit.entries[0];
      const firstGuarded = first !== undefined && first.expectedCur !== undefined;
      const reply = (await this.redis.prepareSnapshotUnit(
        snapshotKeys(runId).cur,
        preparedUnitKey(runId),
        pendingStreamKeyForRun(runId),
        unit.transitionToken,
        JSON.stringify(unit),
        JSON.stringify(staged),
        firstGuarded ? "1" : "0",
        first?.expectedCur ?? "",
        runId
      )) as string[];
      switch (reply[0]) {
        case "busy":
          return { outcome: "busy" };
        case "conflict":
          return { outcome: "conflict" };
        case "idempotent":
          return { outcome: "idempotent", streamId: reply[1] ?? "" };
        case "forkGuard":
          return { outcome: "forkGuard", reason: "head", actualCur: reply[2] ?? "" };
        default:
          return { outcome: "prepared", streamId: reply[1] ?? "" };
      }
    });
  }

  /**
   * CAS on the token: atomically publish the pending unit's ORDERED entries as ONE unit (apply each
   * staged append in order, advancing the committed head), delete the prepared-unit key, and remove
   * the pending-index entry. All-or-nothing, so a reader never sees a subset. Idempotent and
   * lost-reply-safe: a repeat after completion is `noop`. A non-matching token does NOT finalize
   * (`stale`), so it can never affect a newer transition.
   */
  async finalize(runId: string, transitionToken: string): Promise<FinalizeResult> {
    return this.#timed("finalize", async () => {
      const k = snapshotKeys(runId);
      const reply = (await this.redis.finalizeSnapshotUnit(
        k.e,
        k.idx,
        k.cur,
        k.seq,
        residencyKey(runId),
        preparedUnitKey(runId),
        pendingStreamKeyForRun(runId),
        transitionToken,
        String(this.completedTtlMs)
      )) as string[];
      switch (reply[0]) {
        case "noop":
          return { outcome: "noop" };
        case "stale":
          return { outcome: "stale" };
        case "baseMissing":
          return { outcome: "baseMissing" };
        default:
          return { outcome: "finalized", head: reply[1] ?? "" };
      }
    });
  }

  /**
   * CAS abort: delete the prepared-unit key and remove the pending-index entry ONLY if the pending
   * token still matches. It never clears a newer transition (`stale`), and is idempotent (`noop` when
   * nothing is pending).
   */
  async abortPrepared(runId: string, transitionToken: string): Promise<AbortPreparedResult> {
    return this.#timed("abortPrepared", async () => {
      const reply = (await this.redis.abortSnapshotUnit(
        preparedUnitKey(runId),
        pendingStreamKeyForRun(runId),
        transitionToken
      )) as string[];
      switch (reply[0]) {
        case "aborted":
          return { outcome: "aborted" };
        case "stale":
          return { outcome: "stale" };
        default:
          return { outcome: "noop" };
      }
    });
  }

  async getById(
    runId: string,
    snapshotId: string,
    opts?: { environmentId?: string }
  ): Promise<SnapshotRead | null> {
    return this.#timed("getById", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.redis.readSnapshotById(k.e, k.idx, k.cur, k.seq, snapshotId);
      return this.#decode(reply, opts?.environmentId, runId, true);
    });
  }

  async getLatest(runId: string, opts?: { environmentId?: string }): Promise<SnapshotRead | null> {
    return this.#timed("getLatest", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.redis.readLatestSnapshot(k.e, k.idx, k.cur, k.seq);
      return this.#decode(reply, opts?.environmentId, runId, true);
    });
  }

  // Returns all three shapes the Postgres surface needs from one read: `distinctIds` matches the
  // deduped join that findSnapshotCompletedWaitpointIds returns, `present` serves the WithPresence
  // variant (which distinguishes "no waitpoints" from "snapshot not visible"), and `order` keeps the
  // repeats that the engine expands into one CompletedWaitpoint per position.
  async getSnapshotWaitpointIds(runId: string, snapshotId: string): Promise<WaitpointIds> {
    return this.#timed("getSnapshotWaitpointIds", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.redis.readSnapshotWaitpointIds(k.e, k.idx, k.cur, k.seq, snapshotId);
      // A dangling pointer means this entry's waitpoints are unreachable, not absent. Reporting
      // `present: false` is what sends the caller to Postgres, which still holds the join rows.
      if (reply[3] === "1") {
        this.metrics?.recordCycleMismatch();
        this.logger.warn("RedisSnapshotStore snapshot points at a cycle key that is gone", {
          runId,
          snapshotId,
        });
        return { present: false, distinctIds: [], order: [] };
      }
      return decodeWaitpointIds(reply[0] === "1", reply[1] ?? "", reply[2] ?? "");
    });
  }

  // The completed-waitpoint cycle with its full record set, so a redis-primary read reproduces a
  // Postgres read (Postgres holds no join rows for such a run). A dangling pointer is reported, never
  // answered empty, so the caller fails closed instead of resuming a batch with every position lost.
  async getSnapshotCompletedWaitpoints(
    runId: string,
    snapshotId: string
  ): Promise<CompletedWaitpointsRead> {
    return this.#timed("getSnapshotCompletedWaitpoints", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.redis.readSnapshotCompletedWaitpoints(
        k.e,
        k.idx,
        k.cur,
        k.seq,
        snapshotId
      );
      const present = reply[0] === "1";
      const dangling = reply[3] === "1";
      if (!present || dangling) {
        if (dangling) {
          this.metrics?.recordCycleMismatch();
          this.logger.warn("RedisSnapshotStore snapshot points at a cycle key that is gone", {
            runId,
            snapshotId,
          });
        }
        return {
          present,
          danglingCycle: dangling,
          distinctIds: [],
          order: [],
          records: [],
        };
      }
      const ids = decodeWaitpointIds(true, reply[1] ?? "", reply[2] ?? "");
      const records = reply[4] ? (JSON.parse(reply[4]) as CompletedWaitpointRecord[]) : [];
      return {
        present: true,
        danglingCycle: false,
        distinctIds: ids.distinctIds,
        order: ids.order,
        records,
      };
    });
  }

  // A miss is not an error. It is the coexistence path: a pre-cutover snapshot id, expired history,
  // or an org not yet enabled. The caller falls back to Postgres.
  async getSince(
    runId: string,
    sinceId: string,
    opts?: { environmentId?: string; limit?: number }
  ): Promise<GetSinceResult> {
    return this.#timed("getSince", async () => {
      const k = snapshotKeys(runId);
      const limit = opts?.limit ?? this.sinceLimit;
      const reply = await this.redis.readSnapshotsSince(
        k.e,
        k.idx,
        k.cur,
        k.seq,
        sinceId,
        String(limit)
      );
      if (reply === null) return { kind: "miss" };

      const sinceRaw = reply[0] ?? "";
      if (opts?.environmentId !== undefined) {
        // Scoped by the since entry itself, same as Postgres's step-1 lookup: a foreign since id
        // is NOT FOUND regardless of what follows it, never an empty "nothing new" hit.
        if (sinceRaw === "") return { kind: "miss" };
        const since = JSON.parse(sinceRaw) as { environmentId?: string };
        if (since.environmentId !== opts.environmentId) return { kind: "miss" };
      }

      const headOrder = reply[1] ?? "";
      const headDistinct = reply[2] ?? "";
      const headDangling = reply[3] ?? "";
      const rows: SnapshotRead[] = [];
      // Tracks whether the Lua-chosen head row (always the first, WINDOW_HEAD_ROW_INDEX) survives the
      // env filter below -- headOrder must never be attributed to a different, surviving row.
      let headSurvived = false;
      for (let i = WINDOW_HEAD_ROW_INDEX; i + 3 < reply.length; i += 4) {
        // orderKnown is false here: headOrder covers only the head row, resolved separately below.
        const decoded = this.#decode(
          [reply[i], reply[i + 1], reply[i + 2], reply[i + 3], ""],
          opts?.environmentId,
          runId,
          false
        );
        if (decoded) {
          rows.push(decoded);
          if (i === WINDOW_HEAD_ROW_INDEX) headSurvived = true;
        }
      }

      rows.reverse();
      const head = headSurvived ? rows[rows.length - 1] : undefined;
      const headWaitpointIds = decodeWaitpointIds(
        head !== undefined,
        head ? headOrder : "",
        head ? headDistinct : ""
      );
      if (head) {
        head.completedWaitpointIds = headWaitpointIds;
        // A head whose cycle key has expired carries an empty order that means "unknown", not
        // "none". The caller cannot distinguish those, so it has to be told, or it resumes a batch
        // with every position lost. This is what makes the decorator's Postgres fallback reachable
        // on the since-window path as well as the hot read.
        if (headDangling === "1") {
          head.danglingCycle = true;
        }
        if (head.cycle) {
          this.#checkCycleMismatch(runId, head.cycle.count, headWaitpointIds.order.length);
        }
      }
      return { kind: "hit", entries: rows, headWaitpointIds };
    });
  }

  /**
   * The same window as {@link getSince}, addressed by a createdAt cursor instead of a snapshot id.
   *
   * `getExecutionSnapshotsSince` resolves its cursor to a createdAt before it asks for the window,
   * so the snapshot id is gone by the time this call is made and `getSince` cannot serve it. The
   * cursor is exclusive and keeps Postgres's same-millisecond blind spot, so the two reads agree.
   */
  async getSinceCreatedAt(
    runId: string,
    createdAt: Date | string,
    opts?: { environmentId?: string; limit?: number }
  ): Promise<GetSinceResult> {
    return this.#timed("getSinceCreatedAt", async () => {
      const k = snapshotKeys(runId);
      const limit = opts?.limit ?? this.sinceLimit;
      const cursor = typeof createdAt === "string" ? createdAt : createdAt.toISOString();

      const reply = await this.redis.readSnapshotsSinceCreatedAt(
        k.e,
        k.idx,
        k.cur,
        k.seq,
        cursor,
        String(limit)
      );
      if (reply === null) return { kind: "miss" };

      const headOrder = reply[1] ?? "";
      const headDistinct = reply[2] ?? "";
      const headDangling = reply[3] ?? "";
      const rows: SnapshotRead[] = [];
      // Tracks whether the Lua-chosen head row (always the first, WINDOW_HEAD_ROW_INDEX) survives the env filter,
      // so headOrder is never attributed to a different, surviving row.
      let headSurvived = false;
      for (let i = WINDOW_HEAD_ROW_INDEX; i + 3 < reply.length; i += 4) {
        const decoded = this.#decode(
          [reply[i], reply[i + 1], reply[i + 2], reply[i + 3], ""],
          opts?.environmentId,
          runId,
          false
        );
        if (decoded) {
          rows.push(decoded);
          if (i === WINDOW_HEAD_ROW_INDEX) headSurvived = true;
        }
      }

      rows.reverse();
      const head = headSurvived ? rows[rows.length - 1] : undefined;
      const headWaitpointIds = decodeWaitpointIds(
        head !== undefined,
        head ? headOrder : "",
        head ? headDistinct : ""
      );
      if (head) {
        head.completedWaitpointIds = headWaitpointIds;
        // A head whose cycle key has expired carries an empty order that means "unknown", not
        // "none". The caller cannot distinguish those, so it has to be told, or it resumes a batch
        // with every position lost. This is what makes the decorator's Postgres fallback reachable
        // on the since-window path as well as the hot read.
        if (headDangling === "1") {
          head.danglingCycle = true;
        }
        if (head.cycle) {
          this.#checkCycleMismatch(runId, head.cycle.count, headWaitpointIds.order.length);
        }
      }
      return { kind: "hit", entries: rows, headWaitpointIds };
    });
  }

  #checkCycleMismatch(runId: string, count: number, orderLength: number): void {
    if (orderLength === count) return;
    this.metrics?.recordCycleMismatch();
    this.logger.warn("RedisSnapshotStore cycle count disagrees with its order", {
      runId,
      count,
      orderLength,
    });
  }

  // [id, raw, seq, pointer, order] -> SnapshotRead. The environment compare is app-side, per the
  // plan: the store returns null for a foreign environment and the 404 throw stays in the engine.
  // orderKnown distinguishes "order field is genuinely empty" from "order was not read for this
  // row" (getSince's tail rows use the same empty string for the latter) -- the mismatch check and
  // completedWaitpointIds must both be skipped when the order was never read.
  #decode(
    reply: string[] | null,
    environmentId: string | undefined,
    runId: string,
    orderKnown: boolean
  ): SnapshotRead | null {
    if (!reply || reply.length === 0) return null;
    const [id, raw, seqStr, pointer, orderJson, distinctJson, dangling] = reply;
    const entry = JSON.parse(raw) as Record<string, unknown>;
    if (environmentId !== undefined && entry.environmentId !== environmentId) return null;
    const read: SnapshotRead = {
      id,
      seq: Number(seqStr),
      isValid: isValidFor(entry as { error?: unknown }),
      entry,
      raw,
    };
    if (pointer) {
      const [cs, count] = pointer.split(":");
      read.cycle = { cycleSeq: Number(cs), count: Number(count) };
      if (dangling === "1") {
        read.danglingCycle = true;
        this.metrics?.recordCycleMismatch();
        this.logger.warn("RedisSnapshotStore entry points at a cycle key that is gone", {
          runId,
          snapshotId: id,
        });
      }
      if (orderKnown) {
        const ids = decodeWaitpointIds(true, orderJson, distinctJson ?? "");
        read.completedWaitpointIds = ids;
        this.#checkCycleMismatch(runId, Number(count), ids.order.length);
      }
    }
    return read;
  }

  #registerCommands() {
    // Every script declares exactly these four keys and derives snap:{runId}:wp:<n> from KEYS[1] by
    // string surgery. ioredis prefixes only the KEYS array, so a key minted inside Lua would be
    // UNPREFIXED while the client wrote a prefixed one.
    const PRELUDE = `
      local eKey, idxKey, curKey, seqKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
      local base = string.sub(eKey, 1, #eKey - 2)
      local function wpKey(n) return base .. ':wp:' .. n end
      -- The ONE liveness test, shared by the write guard and every read. Two anchors, because keys
      -- expire independently and eviction takes whole keys: seq can be gone while e and cur
      -- survive, and a read answering from cur there serves a frozen head no write can advance.
      local function keyspaceAlive()
        return redis.call('EXISTS', eKey) == 1 and redis.call('EXISTS', seqKey) == 1
      end
      local function orderFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'order') or ''
      end
      -- A pointer whose cycle key is GONE. Not the same as having no pointer: this entry should
      -- have waitpoints and cannot produce them, so a read must refuse rather than answer empty.
      -- Reachable by eviction, and by the completion TTL, which is applied to every key for a run
      -- at the same moment but lets them expire independently.
      local function danglingFor(pointer)
        if not pointer then return '0' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '0' end
        if redis.call('EXISTS', wpKey(cs)) == 0 then return '1' end
        return '0'
      end
      -- The complete id set, which is NOT the order deduped: order holds only batch-indexed ids.
      local function distinctFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'distinct') or ''
      end
      -- The full record set a redis-primary read expands into CompletedWaitpoints. Postgres holds no
      -- join rows for such a run, so this is the only source.
      local function recordsFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'records') or ''
      end
    `;

    // The pure "write this one entry now" core, shared by appendSnapshotEntry (which wraps it in the
    // skip/duplicate/CAS guards) and finalizeSnapshotUnit (which loops it over an already-validated
    // unit, so it needs no guards). Assumes eKey/idxKey/curKey/seqKey/resKey/wpKey are in scope, so it
    // is included AFTER those locals. Returns { seq, cycleSeq, ttl, mismatch }.
    const APPLY_FUNCTION = `
      local function applyEntry(kind, id, raw, isValid, isTerminal, ttlMs, cycleMode, cycleSeqIn, orderJson, records, orderCount, distinctJson, birthMode)
        local seq = redis.call('HINCRBY', seqKey, 'e', 1)

        -- Stamp the versioned state and residency on birth, once and never again.
        if kind == 'birth' then
          redis.call('HSET', seqKey, 'sv', '${SNAPSHOT_STATE_VERSION}')
          if birthMode ~= '' then
            redis.call('SET', resKey, birthMode)
          end
        end

        local cycleSeq = 0
        local mismatch = 0

        local function mintCycle()
          local minted = redis.call('HINCRBY', seqKey, 'c', 1)
          redis.call('HSET', wpKey(minted), 'order', orderJson, 'count', orderCount, 'distinct', distinctJson)
          if records ~= '' then
            redis.call('HSET', wpKey(minted), 'records', records)
          else
            redis.call('HDEL', wpKey(minted), 'records')
          end
          return minted
        end

        if cycleMode == 'new' then
          cycleSeq = mintCycle()
        elseif cycleMode == 'carry' then
          local minted = tonumber(redis.call('HGET', seqKey, 'c') or '0')
          local c = redis.call('HGET', wpKey(cycleSeqIn), 'count')
          if not c or minted < cycleSeqIn then
            mismatch = 1
            if distinctJson ~= '' then
              cycleSeq = mintCycle()
            end
          else
            cycleSeq = cycleSeqIn
            orderCount = c
          end
        end

        redis.call('HSET', eKey, id, raw, id .. '#s', seq)
        if cycleSeq > 0 then
          redis.call('HSET', eKey, id .. '#c', cycleSeq .. ':' .. orderCount)
        end

        if isValid then
          redis.call('ZADD', idxKey, seq, id)
          redis.call('SET', curKey, id)
        end

        local wasTerminal = redis.call('HGET', seqKey, 't') == '1'
        local ttl = 'none'
        if isTerminal then
          redis.call('HSET', seqKey, 't', '1')
        end
        if isTerminal or wasTerminal then
          redis.call('PEXPIRE', eKey, ttlMs)
          redis.call('PEXPIRE', idxKey, ttlMs)
          redis.call('PEXPIRE', curKey, ttlMs)
          redis.call('PEXPIRE', seqKey, ttlMs)
          local high = tonumber(redis.call('HGET', seqKey, 'c') or '0')
          for i = 1, high do
            redis.call('PEXPIRE', wpKey(i), ttlMs)
          end
          -- A MIRRORED run's residency marker expires WITH its state: after 14 days the terminal keys are
          -- gone and its complete Postgres copy is authoritative, so a read cleanly misses to Postgres and
          -- no permanent per-run marker accumulates. A REDIS-PRIMARY marker is kept forever (no PEXPIRE):
          -- it is the only record the run was ever redis-primary, so an expired redis-primary run resolves
          -- to expired/fail-closed instead of silently reading an empty Postgres.
          if redis.call('GET', resKey) == 'mirrored' then
            redis.call('PEXPIRE', resKey, ttlMs)
          end
          if isTerminal and not wasTerminal then
            ttl = 'completion'
          else
            ttl = 'reapplied'
          end
        end

        return { seq, cycleSeq, ttl, mismatch }
      end
    `;

    this.redis.defineCommand("markSnapshotGaps", {
      numberOfKeys: 2,
      lua: `
        local eKey = KEYS[1]
        local seqKey = KEYS[2]
        -- Both anchors, the same pair keyspaceAlive uses. Marking on the strength of one of them
        -- would create the other.
        if redis.call('EXISTS', eKey) == 0 or redis.call('EXISTS', seqKey) == 0 then
          return 0
        end
        redis.call('HSET', seqKey, 'g', '1')
        return 1
      `,
    });

    this.redis.defineCommand("appendSnapshotEntry", {
      numberOfKeys: 5,
      lua: `
        ${PRELUDE}
        -- The residency marker is a SEPARATE physical key sharing the run's {pNNN} tag: it must never
        -- take the terminal TTL the run-state keys get, so it cannot live on the seq hash.
        local resKey = KEYS[5]
        ${APPLY_FUNCTION}
        local kind        = ARGV[1]
        local id          = ARGV[2]
        local raw         = ARGV[3]
        local isValid     = ARGV[4] == '1'
        local isTerminal  = ARGV[5] == '1'
        local ttlMs       = tonumber(ARGV[6])
        local cycleMode   = ARGV[7]
        local cycleSeqIn  = tonumber(ARGV[8])
        local orderJson   = ARGV[9]
        local records     = ARGV[10]
        local orderCount  = ARGV[11]
        local expectedCur = ARGV[12]
        local casEnabled  = ARGV[13] == '1'
        -- The COMPLETE distinct id set. Not the order deduped: order omits every id with no batch
        -- index, and those ids still have to come back on a read.
        local distinctJson = ARGV[14]
        -- Set by the repair. A repair exists BECAUSE an append was lost, so whatever it manages to
        -- put back, the entries between are gone and the window is short.
        local markGaps    = ARGV[15] == '1'
        -- The run's residency, written to the no-TTL res key on a BIRTH only. Empty for a transition
        -- and for a birth with no residency supplied. It is the durable record a foreign process
        -- reads to learn residency.
        local birthMode   = ARGV[16] or ''

        -- Checking e alone would let a late transition recreate seq with no TTL and restart it at 1
        -- beside a surviving idx. A birth always creates both in this same script, so this never
        -- rejects a live keyspace.
        if kind == 'transition' and not keyspaceAlive() then
          return { '${SKIPPED}' }
        end

        -- Append-only: a retried append must not overwrite an existing entry. Checked BEFORE the
        -- CAS below -- a present id can only be this same retry, never a competitor's write.
        local prior = redis.call('HGET', eKey, id .. '#s')
        if prior then
          -- Marked before returning. The caller that asks for a mark is the repair, and a repair
          -- runs BECAUSE an append was lost, so the entries either side are gone whether or not
          -- this particular id had already landed. Returning early without marking left the
          -- keyspace serving short windows as though they were whole.
          if markGaps then
            redis.call('HSET', seqKey, 'g', '1')
          end
          return { '${DUPLICATE}', prior }
        end

        -- Optional compare-and-set on cur, checked BEFORE any mutation. Gated on an explicit flag
        -- (not on expectedCur ~= ''), so a caller asserting cur is unset (expectedCur = '') still
        -- gets a real check instead of silently skipping it.
        if casEnabled then
          local actual = redis.call('GET', curKey)
          if (actual or '') ~= expectedCur then
            -- The one mutation a refused append makes, and it is not part of the append. A fork means
            -- this keyspace and Postgres already disagree about the head, so its history cannot be
            -- served as a window until something re-establishes that it can. The entry itself is
            -- still not written.
            redis.call('HSET', seqKey, 'g', '1')
            return { '${FORKED}', actual or '' }
          end
        end



        -- The index can go while the entry hash and seq survive, and keyspaceAlive does not test it.
        -- This append is about to recreate it holding only the new entry, and a window read would
        -- then see a live index, report a HIT, and return that one entry as though it were the whole
        -- range. Same silent short history as a lost append, so it is recorded the same way: the head
        -- keeps moving and window reads fall back to Postgres, which still holds the log.
        --
        -- Refusing the transition instead would freeze the head, which is the outcome this whole area
        -- exists to avoid.
        if kind == 'transition' and redis.call('EXISTS', idxKey) == 0 then
          redis.call('HSET', seqKey, 'g', '1')
        end

        -- The write itself, shared verbatim with finalize's per-entry publish. idx indexes VALID
        -- entries only; ZADD lands before SET cur because Redis never rolls a partial script back.
        local r = applyEntry(kind, id, raw, isValid, isTerminal, ttlMs, cycleMode, cycleSeqIn, orderJson, records, orderCount, distinctJson, birthMode)
        return { '${WRITTEN}', tostring(r[1]), tostring(r[2]), r[3], tostring(r[4]) }
      `,
    });

    // Stage a transaction-sized prepared unit atomically: the idempotency/busy check, the committed-
    // head fork guard for the first guarded entry, storing the hidden unit + staged entries, and the
    // XADD to the run's partition pending stream, all in one slot via the shared {pNNN} tag. The
    // staged entries are NOT written to the run keyspace, so reads never see them until finalize.
    this.redis.defineCommand("prepareSnapshotUnit", {
      numberOfKeys: 3,
      lua: `
        local curKey = KEYS[1]
        local prepKey = KEYS[2]
        local pendingKey = KEYS[3]
        local token = ARGV[1]
        local unitJson = ARGV[2]
        local stagedJson = ARGV[3]
        local firstGuarded = ARGV[4] == '1'
        local firstExpectedCur = ARGV[5]
        local runId = ARGV[6]

        -- One pending unit per run. A different token cannot overwrite it; the same token is either an
        -- idempotent replay (identical unit) or a reuse with different data (error), never a re-XADD.
        local storedToken = redis.call('HGET', prepKey, 'token')
        if storedToken then
          if storedToken ~= token then
            return { 'busy' }
          end
          if redis.call('HGET', prepKey, 'unit') == unitJson then
            return { 'idempotent', redis.call('HGET', prepKey, 'sid') or '' }
          end
          return { 'conflict' }
        end

        -- The first guarded entry asserts the committed head. Read here so the check is atomic with the
        -- store; the subsequent chain guards are pure payload arithmetic and are validated in TS.
        if firstGuarded then
          local actual = redis.call('GET', curKey) or ''
          if actual ~= firstExpectedCur then
            return { 'forkGuard', 'head', actual }
          end
        end

        redis.call('HSET', prepKey, 'token', token, 'unit', unitJson, 'staged', stagedJson)
        local sid = redis.call('XADD', pendingKey, '*', 'runId', runId, 'transitionToken', token)
        redis.call('HSET', prepKey, 'sid', sid)
        return { 'prepared', sid }
      `,
    });

    // Publish a pending unit atomically (CAS on the token): apply every staged entry in order through
    // the shared applyEntry, delete the prep key, and remove the pending-index entry. A repeat after
    // completion sees no prep key and is a no-op; a non-matching token leaves a newer unit untouched.
    this.redis.defineCommand("finalizeSnapshotUnit", {
      numberOfKeys: 7,
      lua: `
        ${PRELUDE}
        local resKey = KEYS[5]
        local prepKey = KEYS[6]
        local pendingKey = KEYS[7]
        ${APPLY_FUNCTION}
        local token = ARGV[1]
        local ttlMs = tonumber(ARGV[2])

        local storedToken = redis.call('HGET', prepKey, 'token')
        if not storedToken then
          return { 'noop' }
        end
        if storedToken ~= token then
          return { 'stale' }
        end

        local staged = cjson.decode(redis.call('HGET', prepKey, 'staged'))
        -- A birth unit may initialize an empty keyspace; a transition unit MUST have a live,
        -- version-compatible base. A delayed finalize after the terminal TTL expired would otherwise
        -- rebuild a partial history from the staged entries alone, with no state version and no prior
        -- history. Verify atomically and, if the base is absent/partially expired/version-incompatible,
        -- apply nothing and preserve prep + pending so recovery chooses the safe disposition.
        local isBirthUnit = staged[1] ~= nil and staged[1].kind == 'birth'
        if not isBirthUnit then
          local baseOk = keyspaceAlive() and redis.call('HGET', seqKey, 'sv') == '${SNAPSHOT_STATE_VERSION}'
          if not baseOk then
            return { 'baseMissing' }
          end
        end
        for i = 1, #staged do
          local e = staged[i]
          applyEntry(e.kind, e.id, e.raw, e.valid, e.isTerminal, ttlMs, e.cycleMode, e.cycleSeqIn, e.orderJson, e.records, e.orderCount, e.distinctJson, e.birthMode)
        end

        local head = redis.call('GET', curKey) or ''
        local sid = redis.call('HGET', prepKey, 'sid')
        redis.call('DEL', prepKey)
        if sid then
          redis.call('XDEL', pendingKey, sid)
        end
        return { 'finalized', head }
      `,
    });

    // CAS abort: clear pending and remove the pending-index entry only if the token still matches, so
    // a stale abort never clears a newer transition. Idempotent when nothing is pending.
    this.redis.defineCommand("abortSnapshotUnit", {
      numberOfKeys: 2,
      lua: `
        local prepKey = KEYS[1]
        local pendingKey = KEYS[2]
        local token = ARGV[1]
        local storedToken = redis.call('HGET', prepKey, 'token')
        if not storedToken then
          return { 'noop' }
        end
        if storedToken ~= token then
          return { 'stale' }
        end
        local sid = redis.call('HGET', prepKey, 'sid')
        redis.call('DEL', prepKey)
        if sid then
          redis.call('XDEL', pendingKey, sid)
        end
        return { 'aborted' }
      `,
    });

    this.redis.defineCommand("dropSnapshotRun", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        -- The high-water mark, when seq still has it. It is the fast path and the common one.
        local cycles = tonumber(redis.call('HGET', seqKey, 'c') or '0')
        for i = 1, cycles do
          redis.call('DEL', wpKey(i))
        end

        -- seq holds the count, so seq being gone used to mean the count read as 0 and every wait
        -- cycle key was left behind, while this command claimed to remove the whole keyspace. An
        -- orphan the sweep cannot see either, because it discovers keyspaces by the entry hash.
        --
        -- So sweep a bounded range unconditionally. A miss-streak early exit was wrong: cycle keys
        -- can be SPARSE, so with seq gone and only wp:10 alive, stopping after a run of absent keys
        -- leaves it behind, and the entry hash is deleted below so the sweep can never find it
        -- either. Every key here shares the {runId} tag, so this stays inside one slot, and the
        -- bound keeps a pathological run from turning a drop into a long script.
        for probe = cycles + 1, cycles + 512 do
          redis.call('DEL', wpKey(probe))
        end

        return redis.call('DEL', eKey, idxKey, curKey, seqKey)
      `,
    });

    this.redis.defineCommand("readSnapshotById", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        if not keyspaceAlive() then return nil end
        local id = ARGV[1]
        local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
        if not vals[1] then return nil end
        -- Coerce every element: a Lua false TRUNCATES the returned array at that position.
        return { id, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]), distinctFor(vals[3]), danglingFor(vals[3]) }
      `,
    });

    this.redis.defineCommand("readLatestSnapshot", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        if not keyspaceAlive() then return nil end
        local cur = redis.call('GET', curKey)
        if not cur then return nil end
        local vals = redis.call('HMGET', eKey, cur, cur .. '#s', cur .. '#c')
        if not vals[1] then return nil end
        return { cur, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]), distinctFor(vals[3]), danglingFor(vals[3]) }
      `,
    });

    this.redis.defineCommand("readSnapshotWaitpointIds", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local id = ARGV[1]
        -- Not present, which is what sends the caller to Postgres. An empty id set from an
        -- incomplete keyspace would read as authoritative.
        if not keyspaceAlive() then return { '0', '' } end
        if redis.call('HEXISTS', eKey, id) == 0 then
          return { '0', '' }
        end
        local pointer = redis.call('HGET', eKey, id .. '#c')
        return { '1', orderFor(pointer), distinctFor(pointer), danglingFor(pointer) }
      `,
    });

    this.redis.defineCommand("readSnapshotCompletedWaitpoints", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local id = ARGV[1]
        -- Not present, which fails a redis-primary read closed: an empty set from an incomplete
        -- keyspace would otherwise read as authoritative.
        if not keyspaceAlive() then return { '0', '', '', '0', '' } end
        if redis.call('HEXISTS', eKey, id) == 0 then
          return { '0', '', '', '0', '' }
        end
        local pointer = redis.call('HGET', eKey, id .. '#c')
        return { '1', orderFor(pointer), distinctFor(pointer), danglingFor(pointer), recordsFor(pointer) }
      `,
    });

    this.redis.defineCommand("readSnapshotsSinceCreatedAt", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local cursor = ARGV[1]
        local limit = tonumber(ARGV[2])

        -- A run with no keyspace is a MISS, so the caller falls back to Postgres. A run that has one
        -- and nothing newer is an empty HIT, so it does not fall back for a window it owns.
        --
        -- Both anchors, for the reason the append script gives: keys expire independently, and an
        -- index lost to eviction while the entry hash survives would otherwise report an empty HIT
        -- on every poll for the rest of the run's life, with Postgres holding the transitions.
        if not keyspaceAlive() or redis.call('EXISTS', idxKey) == 0 then return nil end

        -- A keyspace that lost an append has a hole, and no guard downstream can see one: a window
        -- that should hold eight entries would return four and look complete. Refuse, and the
        -- caller's existing miss path asks Postgres, which still holds the whole log.
        if redis.call('HGET', seqKey, 'g') == '1' then return nil end

        -- STRICTLY greater than the cursor, and same-millisecond entries are dropped. Postgres
        -- serves this window with createdAt > cursor and drops them too; a Redis read that is more
        -- correct than the Postgres read shows up as divergence in compare mode.
        --
        -- createdAt is always toISOString() output, one fixed-width UTC format, so a lexicographic
        -- compare is a chronological compare. Walking newest-first lets the scan stop at the first
        -- entry at or before the cursor, which makes its length the length of the ANSWER rather
        -- than the length of the run's history.
        local out = { '', '', '', '' }
        local headId = nil
        local offset = 0
        local page = limit
        local done = false

        while not done do
          local ids = redis.call('ZREVRANGE', idxKey, offset, offset + page - 1)
          if #ids == 0 then break end

          for i = 1, #ids do
            local id = ids[i]
            local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
            if vals[1] then
              local createdAt = cjson.decode(vals[1])['createdAt']
              if not createdAt or createdAt <= cursor then
                done = true
                break
              end
              if not headId then headId = id end
              out[#out + 1] = id
              out[#out + 1] = vals[1]
              out[#out + 1] = vals[2] or ''
              out[#out + 1] = vals[3] or ''
              if (#out - 2) / 4 >= limit then
                done = true
                break
              end
            end
          end

          offset = offset + page
        end

        if headId then
          local headPointer = redis.call('HGET', eKey, headId .. '#c')
          out[2] = orderFor(headPointer)
          out[3] = distinctFor(headPointer)
          -- The head's cycle key can expire while its entry survives: the completion TTL is applied
          -- per key. Without this flag the head returns an EMPTY order and the caller cannot tell
          -- that from a head that genuinely had no indexed waitpoints, so a batched resume loses
          -- every position instead of falling back to Postgres.
          out[4] = danglingFor(headPointer)
        end
        return out
      `,
    });

    this.redis.defineCommand("readSnapshotsSince", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local sinceId = ARGV[1]
        local limit = tonumber(ARGV[2])

        -- Same gate as the sibling window command: without it a lost index reports an empty HIT,
        -- so the caller stops asking Postgres for a window Postgres alone still holds.
        if not keyspaceAlive() or redis.call('EXISTS', idxKey) == 0 then return nil end

        -- And the same hole gate, for the same reason. A caller that fell back on one window command
        -- and not the other would still serve a short history through the second.
        if redis.call('HGET', seqKey, 'g') == '1' then return nil end

        -- The index holds valid entries only, so an invalid since id misses ZSCORE. Its seq is still
        -- on its own '#s' field, which keeps the id resolvable without indexing invalid rows.
        local score = redis.call('ZSCORE', idxKey, sinceId)
        if not score then
          score = redis.call('HGET', eKey, sinceId .. '#s')
          if not score then return nil end
        end

        -- Env scoping is decided from the since entry itself, not from the window it produces.
        local sinceRaw = redis.call('HGET', eKey, sinceId) or ''

        -- NEWEST-first with a limit, then reversed app-side. The engine reads createdAt desc /
        -- take N / reverse, so the oldest-first form would return the wrong window entirely.
        local ids = redis.call('ZREVRANGEBYSCORE', idxKey, '+inf', '(' .. score, 'LIMIT', 0, limit)
        if #ids == 0 then return { sinceRaw, '' } end

        -- The head is the newest SURVIVING entry, and it is the only one whose cycle key is read.
        -- Deriving the order after the loop keeps it paired with the row it is attached to: a row
        -- dropped for a missing body must not donate its cycle data to the next one.
        local out = { sinceRaw, '', '', '' }
        local headId = nil
        for i = 1, #ids do
          local id = ids[i]
          local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
          if vals[1] then
            if not headId then headId = id end
            out[#out + 1] = id
            out[#out + 1] = vals[1]
            out[#out + 1] = vals[2] or ''
            out[#out + 1] = vals[3] or ''
          end
        end
        if headId then
          local headPointer = redis.call('HGET', eKey, headId .. '#c')
          out[2] = orderFor(headPointer)
          out[3] = distinctFor(headPointer)
          -- The head's cycle key can expire while its entry survives: the completion TTL is applied
          -- per key. Without this flag the head returns an EMPTY order and the caller cannot tell
          -- that from a head that genuinely had no indexed waitpoints, so a batched resume loses
          -- every position instead of falling back to Postgres.
          out[4] = danglingFor(headPointer)
        end
        return out
      `,
    });
  }
}

export function decodeWaitpointIds(
  present: boolean,
  orderJson: string,
  distinctJson = ""
): WaitpointIds {
  const order: string[] = orderJson === "" ? [] : (JSON.parse(orderJson) as string[]);

  // The complete set is stored separately, because `order` omits every id with no batch index, so
  // deduping the order to recover it silently drops every wait that has none.
  //
  // A cycle key always holds both fields, written by one command, so a missing `distinct` beside a
  // NON-EMPTY `order` means the invariant is broken. Reconstructing from the order there would be
  // the same lossy shortcut this field exists to remove, and the loss would be silent. Report the
  // entry as not present instead, which sends the caller to Postgres.
  if (distinctJson === "" && order.length > 0) {
    return { present: false, distinctIds: [], order: [] };
  }

  const distinctIds: string[] = distinctJson === "" ? [] : (JSON.parse(distinctJson) as string[]);
  return { present, distinctIds, order };
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    dropSnapshotRun(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      callback?: Callback<number>
    ): Result<number, Context>;
    markSnapshotGaps(
      eKey: string,
      seqKey: string,
      callback?: Callback<number>
    ): Result<number, Context>;
    appendSnapshotEntry(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      resKey: string,
      kind: string,
      id: string,
      raw: string,
      isValid: string,
      isTerminal: string,
      ttlMs: string,
      cycleMode: string,
      cycleSeqIn: string,
      orderJson: string,
      records: string,
      orderCount: string,
      expectedCur: string,
      casEnabled: string,
      distinctJson: string,
      markGaps: string,
      birthMode: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    readSnapshotById(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      id: string,
      callback?: Callback<string[] | null>
    ): Result<string[] | null, Context>;
    readLatestSnapshot(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      callback?: Callback<string[] | null>
    ): Result<string[] | null, Context>;
    readSnapshotWaitpointIds(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      id: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    readSnapshotCompletedWaitpoints(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      id: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    readSnapshotsSinceCreatedAt(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      createdAtCursor: string,
      limit: string,
      callback?: Callback<string[] | null>
    ): Result<string[] | null, Context>;
    readSnapshotsSince(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      sinceId: string,
      limit: string,
      callback?: Callback<string[] | null>
    ): Result<string[] | null, Context>;
    prepareSnapshotUnit(
      curKey: string,
      prepKey: string,
      pendingKey: string,
      token: string,
      unitJson: string,
      stagedJson: string,
      firstGuarded: string,
      firstExpectedCur: string,
      runId: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    finalizeSnapshotUnit(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      resKey: string,
      prepKey: string,
      pendingKey: string,
      token: string,
      ttlMs: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
    abortSnapshotUnit(
      prepKey: string,
      pendingKey: string,
      token: string,
      callback?: Callback<string[]>
    ): Result<string[], Context>;
  }
}
