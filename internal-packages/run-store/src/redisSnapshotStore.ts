import {
  createRedisClient,
  type Callback,
  type RedisClient,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import type { SnapshotReadWaitpoint } from "./types.js";
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
 * Holds a pending unit recovery cannot resolve. It never takes a TTL, so the record stays
 * inspectable.
 */
function quarantineKey(runId: string): string {
  return `${SNAPSHOT_NAMESPACE}:quarantine:{${partitionTag(runToPartition(runId))}}:${runId}`;
}
function quarantineKeyPrefix(partition: number): string {
  return `${SNAPSHOT_NAMESPACE}:quarantine:{${partitionTag(partition)}}:`;
}

/** Read retry backoff. The total stays shorter than one client command timeout. */
const READ_RETRY_DELAYS_MS = [50, 150] as const;

/**
 * True for a client-side failure (timeout, reconnect budget, closed socket). A command timeout can
 * fire after the reply arrived, while the event loop is stalled. A server reply error is not
 * transient: a retry returns the same answer.
 */
export function isTransientRedisClientError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  if (error.name === "MaxRetriesPerRequestError") return true;
  if (error.message.includes("Command timed out")) return true;
  if (error.message.includes("Connection is closed")) return true;
  const code = (error as { code?: unknown }).code;
  return code === "ECONNRESET" || code === "EPIPE";
}

export type QuarantinedRecord = {
  unit: PreparedPgUnit;
  reason: string;
  quarantinedAt: string;
  /** The raw, unparseable value, preserved verbatim when the unit was structurally invalid. */
  raw?: string;
};

/**
 * The state version check. `unknown` (a future or missing version) fails closed: it is never a
 * usable head and never a Postgres miss.
 */
export type StateVersionRead =
  | { kind: "absent" }
  | { kind: "known" }
  | { kind: "unknown"; version: string | null };

export type CompletedWaitpointRef = { id: string; index?: number };

// Must match PostgresRunStore.#createExecutionSnapshot's completedWaitpointOrder. Repeats are kept,
// because one run can sit in a batch more than once under a single idempotency key.
export function deriveOrder(completedWaitpoints: CompletedWaitpointRef[]): string[] {
  return completedWaitpoints
    .filter((w) => w.index !== undefined)
    .sort((a, b) => a.index! - b.index!)
    .map((w) => w.id);
}

/**
 * The complete distinct set of completed-waitpoint ids, including waits with no batch index. Do not
 * derive it from `order`: `order` holds only batch-indexed ids, so the run would lose the results
 * of every `wait.for`, single `triggerAndWait` and token.
 */
export function deriveDistinctIds(completedWaitpoints: CompletedWaitpointRef[]): string[] {
  return [...new Set(completedWaitpoints.map((w) => w.id))];
}

// Derived, never stored, so the entry JSON stays byte-identical to the caller's document.
export function isValidFor(entry: { error?: unknown }): boolean {
  return !entry.error;
}

// ---------------------------------------------------------------------------
// Completed-waitpoint contract, shared with the waitpoint lane.
// Do not change a field without agreeing it with that lane.
// ---------------------------------------------------------------------------

/**
 * `cycleSeq` names the run's `wp:<cycleSeq>` key. `count` is `order.length`, not the record count,
 * so it is zero for a wait with no batch index.
 */
export type CompletedWaitpointsPointer = {
  cycleSeq: number;
  count: number;
};

/**
 * A record's output.
 * - `inline`: the literal value. Error outputs are not truncated, so only the completion body
 *   limit bounds them.
 * - `ref`: a reference to output that was already offloaded.
 * - `deriveFromRun`: the resolver reads `TaskRun.output`. Only a non-error RUN record with a
 *   `completedByTaskRunId` can use it, because `TaskRun.output` holds the same string verbatim.
 *   `TaskRun.error` is jsonb and does not round-trip. A RUN waitpoint whose run row was deleted
 *   (onDelete: SetNull) carries its output inline.
 */
export type CompletedWaitpointRecordOutput =
  | { inline: string }
  | { ref: string }
  | { deriveFromRun: true }
  | null;

/**
 * One record per DISTINCT id in a cycle. The resolver makes one unenhanced row from each;
 * run-engine expands it across `order`.
 */
export type CompletedWaitpointRecord = {
  id: string;
  friendlyId: string;
  type: "RUN" | "BATCH" | "DATETIME" | "MANUAL";
  /** ISO. The writer applies the null fallback once. */
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

/** The store reads and parses the cycle hash. The resolver never touches Redis. */
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
 * Implemented in run-engine, because a `deriveFromRun` record needs a Postgres read. Returns
 * UNENHANCED rows, one per distinct record, the same as a Postgres store read. run-engine's
 * enhancement step does the index expansion.
 */
export type CompletedWaitpointResolver = (
  args: ResolveCompletedWaitpointsArgs
) => Promise<SnapshotReadWaitpoint[]>;

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
   * RESERVED. Always unset; `append` rejects a set value. The pointer lives in the `<snapshotId>#c`
   * sidecar field, because the entry JSON must stay byte-identical to the Postgres row, which has
   * no pointer column.
   */
  completedWaitpoints?: CompletedWaitpointsPointer;
};

export type WaitpointIds = { present: boolean; distinctIds: string[]; order: string[] };

/**
 * A snapshot's completed-waitpoint cycle with its records. `danglingCycle` means the cycle key is
 * gone: the waitpoints are unreachable, not absent, so the read must fail closed.
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
   * The cycle key is gone, so the waitpoints are unreachable, not absent. Only redis-primary runs
   * have cycles and Postgres has no join rows for them, so the read must fail closed.
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

/** The outcome labels the metrics layer accepts. */
export const APPEND_RESULT_OUTCOMES = [
  "written",
  "skippedNoKeyspace",
  "forked",
  "duplicate",
] as const satisfies readonly AppendResult["outcome"][];

// Fails the build when AppendResult gets an outcome that the list above does not have.
type AssertSameOutcomes<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _outcomesExhaustive: AssertSameOutcomes<
  (typeof APPEND_RESULT_OUTCOMES)[number],
  AppendResult["outcome"]
> = true;
void _outcomesExhaustive;

/** Completed-waitpoint refs and records that let a redis-primary read reproduce a Postgres read. */
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

/** One staged entry in a pending unit. */
export type PreparedEntry = {
  entry: SnapshotEntryInput;
  kind: "birth" | "transition";
  isTerminal: boolean;
  /** Fork guard: the head snapshot id this entry expects, or "" for none. */
  expectedCur?: string;
  cycle?: AppendCyclePayload;
};

/**
 * The pending unit: the ordered snapshot entries of one owning Postgres transaction. Reads cannot
 * see it until {@link RedisSnapshotStore.finalize} publishes the whole unit at once.
 */
export type PreparedPgUnit = {
  protocolVersion: number;
  transitionToken: string;
  /** The owning transaction's xid8. Recovery checks it with `pg_xact_status`. */
  postgresXid: string;
  runId: string;
  organizationId: string;
  residency: string;
  /** The store route; never a connection string or host. */
  logicalRunStoreRoute: string;
  entries: PreparedEntry[];
  /** Mirrored only: an entry id of this transaction. Recovery reads it to prove the commit. */
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
  // The base keyspace is gone or version-incompatible. Nothing was applied, and the pending unit
  // stays for recovery.
  | { outcome: "baseMissing" };

export type AbortPreparedResult =
  | { outcome: "aborted" }
  | { outcome: "noop" }
  | { outcome: "stale" };

// The finalize Lua's per-entry input. Built like append()'s ARGV, so both write identical bytes.
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
 * Exactly one of `client` or `redisOptions`. Production passes a cluster client. Every per-run key
 * carries the run's `{pNNN}` partition tag, so one slot holds a run and its partition's pending
 * stream, and both endpoint shapes behave the same. `quit()` leaves a caller-supplied client open.
 */
export type RedisSnapshotStoreConnection =
  | { client: RedisClient; redisOptions?: never }
  | { client?: never; redisOptions: RedisOptions };

export type RedisSnapshotStoreOptions = RedisSnapshotStoreConnection & {
  /** Readiness gate for a lazily constructed client. */
  beforeCommand?: (operation: string) => Promise<void>;
  completedTtlMs: number;
  sinceLimit?: number;
  highWater?: { entryBytes?: number; cycleKeyBytes?: number; cycleCount?: number };
  metrics?: SnapshotStoreMetrics;
  logger?: Logger;
};

/**
 * Both window scripts return four leading slots (`sinceRaw`, head order, head distinct set, head
 * dangling flag), then rows in four-element groups. The head row is the group at this offset.
 */
const WINDOW_HEAD_ROW_INDEX = 4;

const SKIPPED = "skipped";
const FORKED = "forked";
const WRITTEN = "written";
const DUPLICATE = "duplicate";

export class RedisSnapshotStore {
  private readonly redis: RedisClient;
  private readonly ownsClient: boolean;
  private readonly logger: Logger;
  private readonly completedTtlMs: number;
  private readonly sinceLimit: number;
  private readonly metrics?: SnapshotStoreMetrics;
  private readonly highWater: NonNullable<RedisSnapshotStoreOptions["highWater"]>;
  private readonly beforeCommand?: RedisSnapshotStoreOptions["beforeCommand"];
  #quit?: Promise<void>;

  constructor(options: RedisSnapshotStoreOptions) {
    this.logger = options.logger ?? new Logger("RedisSnapshotStore", "debug");
    this.completedTtlMs = options.completedTtlMs;
    this.sinceLimit = options.sinceLimit ?? 50;
    this.metrics = options.metrics;
    this.highWater = options.highWater ?? {};
    this.beforeCommand = options.beforeCommand;
    this.ownsClient = options.client === undefined;
    this.redis =
      options.client ??
      createRedisClient(options.redisOptions, {
        onError: (error) => this.logger.error("RedisSnapshotStore redis client error", { error }),
      });
    this.#registerCommands();
  }

  async quit(): Promise<void> {
    // Idempotent and swallows errors, so a second quit() never masks a test failure. A borrowed
    // client is shared with other components, so it stays open.
    if (!this.ownsClient) return;
    if (!this.#quit) {
      this.#quit = this.redis.quit().then(
        () => undefined,
        () => undefined
      );
    }
    await this.#quit;
  }

  /** Records latency and runs the readiness gate for every command. */
  async #timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      if (this.beforeCommand) await this.beforeCommand(op);
      return await fn();
    } finally {
      this.metrics?.recordLatency(op, Date.now() - started);
    }
  }

  /**
   * Retries a read on a transient client error. Reads only: a timed-out write may have applied, so
   * a replay is not safe.
   */
  async #retryingRead<T>(op: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const delayMs = READ_RETRY_DELAYS_MS[attempt];
        if (delayMs === undefined || !isTransientRedisClientError(error)) throw error;
        this.logger.debug("RedisSnapshotStore retrying read after a transient client error", {
          op,
          attempt: attempt + 1,
          delayMs,
          error: error instanceof Error ? error.message : String(error),
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  /** Marks the keyspace as gapped, so reads refuse it. Legacy: no production caller. */
  async markGaps(runId: string): Promise<void> {
    await this.redis.hset(snapshotKeys(runId).seq, "g", "1");
  }

  /**
   * Marks only a keyspace that exists, and reports whether it did. Legacy: no production caller.
   * {@link markGaps} on a non-resident run creates a lone `seq` key with no TTL that nothing
   * deletes.
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
   * The birth residency (`mirrored` or `redis-primary`), or undefined when there is no marker. A
   * redis-primary marker has no TTL, so an expired redis-primary run stays distinct from a
   * Postgres-resident one. A mirrored marker expires with the run state.
   */
  async readBirthResidency(runId: string): Promise<string | undefined> {
    const mode = await this.#timed("readBirthResidency", () =>
      this.#retryingRead("readBirthResidency", () => this.redis.get(residencyKey(runId)))
    );
    return mode ?? undefined;
  }

  /** The organizationId on the finalized head entry, or undefined when there is no head. */
  async readCommittedOrganizationId(runId: string): Promise<string | undefined> {
    const head = await this.getLatest(runId);
    const organizationId = (head?.entry as { organizationId?: unknown } | undefined)
      ?.organizationId;
    return typeof organizationId === "string" ? organizationId : undefined;
  }

  /**
   * Whether a pending unit exists and whether a quarantine record exists, in one round trip. A
   * quarantine record means the run fails closed and must not resolve to Postgres.
   */
  async readPendingState(runId: string): Promise<{ prepared: boolean; quarantined: boolean }> {
    return this.#timed("readPendingState", async () => {
      const reply = (await this.#retryingRead("readPendingState", () =>
        this.redis.readPendingState(preparedUnitKey(runId), quarantineKey(runId))
      )) as [number, number];
      return { prepared: reply[0] === 1, quarantined: reply[1] === 1 };
    });
  }

  /**
   * Whether a pending unit exists. Residency resolution uses {@link readPendingState}, which also
   * checks quarantine. `retry: false` makes one attempt, for a caller that retries itself.
   */
  async hasPreparedUnit(runId: string, opts?: { retry?: boolean }): Promise<boolean> {
    return this.#timed("hasPreparedUnit", async () => {
      const read = () => this.redis.exists(preparedUnitKey(runId));
      const exists = await (opts?.retry === false
        ? read()
        : this.#retryingRead("hasPreparedUnit", read));
      return exists === 1;
    });
  }

  /**
   * The raw pending unit JSON, or undefined. Recovery parses it, so a corrupt payload is a
   * structural error it can quarantine, not a retriable availability error.
   */
  async readPreparedUnitRaw(runId: string): Promise<string | undefined> {
    return this.#timed("readPreparedUnitRaw", async () => {
      const raw = await this.redis.hget(preparedUnitKey(runId), "unit");
      return raw ?? undefined;
    });
  }

  /**
   * Moves the pending unit to the quarantine key, only while `prep` still holds this unit's token,
   * so a newer unit is never quarantined. The stream entry stays for the recovery sweep to settle.
   * Runs before the caller ACKs, so a crash cannot lose the record.
   */
  async quarantinePreparedUnit(
    unit: PreparedPgUnit,
    reason: string,
    raw?: string
  ): Promise<{ moved: boolean }> {
    return this.#timed("quarantinePreparedUnit", async () => {
      const moved = (await this.redis.quarantinePreparedUnit(
        quarantineKey(unit.runId),
        preparedUnitKey(unit.runId),
        JSON.stringify(unit),
        reason,
        new Date().toISOString(),
        unit.transitionToken,
        raw !== undefined ? "1" : "0",
        raw ?? ""
      )) as number;
      return { moved: moved === 1 };
    });
  }

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

  /** SCANs every master. Do not use on a hot path. */
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
   * The `maxmemory-policy`. Only `noeviction` is safe, because pending, active and quarantine
   * records must never be evicted. Undefined when it cannot be read; the caller must fail closed.
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

  // The recovery sweep's fleet lease. One script, so no pod can renew another pod's lease.
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

  // Compare-owner, so a former owner cannot delete a successor's lease.
  async releaseRecoveryLease(owner: string): Promise<void> {
    await this.redis.eval(
      `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) else return 0 end`,
      1,
      recoveryLeaseKey(),
      owner
    );
  }

  /**
   * Sets the protocol marker when it is absent, then compares it with `validatedVersion`. A Redis
   * error throws, so the caller fails closed.
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

  /** A keyspace with an unknown or missing state version is `unknown`, never a clean miss. */
  async readStateVersion(runId: string): Promise<StateVersionRead> {
    return this.#timed("readStateVersion", async () => {
      const k = snapshotKeys(runId);
      const [exists, sv] = (await this.#retryingRead("readStateVersion", () =>
        this.redis.multi().exists(k.seq).hget(k.seq, "sv").exec()
      )) as [[Error | null, number], [Error | null, string | null]];
      if ((exists[1] ?? 0) === 0) return { kind: "absent" };
      const version = sv[1] ?? null;
      if (version === SNAPSHOT_STATE_VERSION) return { kind: "known" };
      return { kind: "unknown", version };
    });
  }

  /**
   * Deletes a run's whole keyspace, cycle keys included. Legacy: no production caller. Only safe
   * when Postgres holds the run's rows.
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
     * The residency (`mirrored` or `redis-primary`) stamped on a BIRTH. Ignored for a transition.
     */
    birthMode?: string;
    /** Marks the keyspace as gapped, so reads refuse it. */
    markGaps?: boolean;
    // A refused carry mints a new cycle from these refs. Without refs the entry gets no pointer.
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

        // Used only if the script refuses the carry and mints a replacement.
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
      // No keyspace: a postgres run, or one whose state has aged out. Only readBirthResidency can
      // tell them apart.
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
      // The whole wp:<cycleSeq> key: records dominate its size.
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

  // Must match append()'s ARGV derivation, so both write identical bytes.
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
   * Stages the pending unit and XADDs its partition stream entry in one script. Reads cannot see it
   * until {@link finalize}. One pending unit per run: another token is `busy`, the same token with
   * the same unit is `idempotent`, and the same token with other data is a `conflict`. The first
   * guarded entry must match `cur` (checked in Lua); each later guarded entry must match the entry
   * before it.
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

  /** Sets an empty mirrored `cur` to an entry already in `e` and `idx`. Never replaces a head. */
  async repairMirroredHead(
    entry: Pick<SnapshotEntryInput, "runId" | "id">,
    observedCur: string
  ): Promise<boolean> {
    const keys = snapshotKeys(entry.runId);
    return (
      (await this.redis.repairMirroredSnapshotHead(
        keys.e,
        keys.idx,
        keys.cur,
        keys.seq,
        residencyKey(entry.runId),
        preparedUnitKey(entry.runId),
        quarantineKey(entry.runId),
        observedCur,
        entry.id
      )) === 1
    );
  }

  /**
   * Publishes every staged entry of the unit at once, then removes the unit and its stream entry. A
   * reader never sees a subset. A repeat is `noop`; another token is `stale` and changes nothing.
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
   * Removes the unit and its stream entry only while the token matches, so a newer unit is safe.
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

  // `retry: false` fails fast, for a caller that holds the run lock or an open transaction.
  async getById(
    runId: string,
    snapshotId: string,
    opts?: { environmentId?: string; retry?: boolean }
  ): Promise<SnapshotRead | null> {
    return this.#timed("getById", async () => {
      const k = snapshotKeys(runId);
      const read = () => this.redis.readSnapshotById(k.e, k.idx, k.cur, k.seq, snapshotId);
      const reply = await (opts?.retry === false ? read() : this.#retryingRead("getById", read));
      return this.#decode(reply, opts?.environmentId, runId, true);
    });
  }

  async getLatest(
    runId: string,
    opts?: { environmentId?: string; retry?: boolean }
  ): Promise<SnapshotRead | null> {
    return this.#timed("getLatest", async () => {
      const k = snapshotKeys(runId);
      const read = () => this.redis.readLatestSnapshot(k.e, k.idx, k.cur, k.seq);
      const reply = await (opts?.retry === false ? read() : this.#retryingRead("getLatest", read));
      return this.#decode(reply, opts?.environmentId, runId, true);
    });
  }

  // `distinctIds` matches findSnapshotCompletedWaitpointIds. `present` tells "no waitpoints" from
  // "snapshot not visible". `order` keeps the repeats the engine expands per position.
  async getSnapshotWaitpointIds(runId: string, snapshotId: string): Promise<WaitpointIds> {
    return this.#timed("getSnapshotWaitpointIds", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.#retryingRead("getSnapshotWaitpointIds", () =>
        this.redis.readSnapshotWaitpointIds(k.e, k.idx, k.cur, k.seq, snapshotId)
      );
      // Dangling: the waitpoints are unreachable, not absent. `present: false` fails the read
      // closed.
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

  // A dangling cycle is reported, never answered empty, so the redis-primary caller fails closed.
  async getSnapshotCompletedWaitpoints(
    runId: string,
    snapshotId: string,
    opts?: { retry?: boolean }
  ): Promise<CompletedWaitpointsRead> {
    return this.#timed("getSnapshotCompletedWaitpoints", async () => {
      const k = snapshotKeys(runId);
      const read = () =>
        this.redis.readSnapshotCompletedWaitpoints(k.e, k.idx, k.cur, k.seq, snapshotId);
      const reply = await (opts?.retry === false
        ? read()
        : this.#retryingRead("getSnapshotCompletedWaitpoints", read));
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

  // Legacy: no production caller. The decorator reads windows through getSinceCreatedAt.
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
        // As in Postgres, a since id from another environment is a miss, never an empty hit.
        if (sinceRaw === "") return { kind: "miss" };
        const since = JSON.parse(sinceRaw) as { environmentId?: string };
        if (since.environmentId !== opts.environmentId) return { kind: "miss" };
      }

      const headOrder = reply[1] ?? "";
      const headDistinct = reply[2] ?? "";
      const headDangling = reply[3] ?? "";
      const rows: SnapshotRead[] = [];
      // headOrder belongs to the head row only, so it is dropped if the env filter drops that row.
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
        // An expired cycle key gives an empty order that means "unknown", not "none". Flag it so
        // the caller fails closed instead of resuming a batch with every position lost.
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
   * The redis-primary window after an exclusive createdAt cursor. It keeps Postgres's
   * same-millisecond blind spot, so both reads agree.
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

      const reply = await this.#retryingRead("getSinceCreatedAt", () =>
        this.redis.readSnapshotsSinceCreatedAt(k.e, k.idx, k.cur, k.seq, cursor, String(limit))
      );
      if (reply === null) return { kind: "miss" };

      const headOrder = reply[1] ?? "";
      const headDistinct = reply[2] ?? "";
      const headDangling = reply[3] ?? "";
      const rows: SnapshotRead[] = [];
      // headOrder belongs to the head row only, so it is dropped if the env filter drops that row.
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
        // An expired cycle key gives an empty order that means "unknown", not "none". Flag it so
        // the caller fails closed instead of resuming a batch with every position lost.
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

  // Returns null for a foreign environment; the engine throws the 404. `orderKnown: false` means
  // the order was not read for this row, so the waitpoint ids and the mismatch check are skipped.
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
    // A script that includes PRELUDE passes the run's e, idx, cur and seq keys as KEYS[1..4]. The
    // cycle key is derived from KEYS[1], so it keeps the client's key prefix and the `{pNNN}` tag.
    const PRELUDE = `
      local eKey, idxKey, curKey, seqKey = KEYS[1], KEYS[2], KEYS[3], KEYS[4]
      local base = string.sub(eKey, 1, #eKey - 2)
      local function wpKey(n) return base .. ':wp:' .. n end
      -- The one liveness test. Keys expire independently, so cur alone can serve a head no write
      -- can advance.
      local function keyspaceAlive()
        return redis.call('EXISTS', eKey) == 1 and redis.call('EXISTS', seqKey) == 1
      end
      -- A gapped keyspace has a hole in its history, so every read refuses it. Only the legacy
      -- append, markGaps and markGapsIfResident set g; prepare never does.
      local function gapped()
        return redis.call('HGET', seqKey, 'g') == '1'
      end
      local function orderFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'order') or ''
      end
      -- A pointer whose cycle key is gone (eviction, or independent expiry). The read must refuse,
      -- not answer empty.
      local function danglingFor(pointer)
        if not pointer then return '0' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '0' end
        if redis.call('EXISTS', wpKey(cs)) == 0 then return '1' end
        return '0'
      end
      -- Not order deduped: order holds only batch-indexed ids.
      local function distinctFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'distinct') or ''
      end
      -- The only source of records for a redis-primary run: Postgres has no join rows.
      local function recordsFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'records') or ''
      end
    `;

    // Writes one entry with no guards; callers validate first. Include it after the eKey, idxKey,
    // curKey, seqKey, resKey and wpKey locals. Returns { seq, cycleSeq, ttl, mismatch }.
    const APPLY_FUNCTION = `
      local function applyEntry(kind, id, raw, isValid, isTerminal, ttlMs, cycleMode, cycleSeqIn, orderJson, records, orderCount, distinctJson, birthMode)
        local seq = redis.call('HINCRBY', seqKey, 'e', 1)

        -- Birth only: stamp the state version and residency.
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

        -- Only valid entries are indexed. ZADD comes before SET cur: Redis never rolls back a
        -- partial script.
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
          -- A mirrored marker expires with the state, because Postgres holds the full copy. A
          -- redis-primary marker never expires: it is the only proof the run was redis-primary, so
          -- an expired run fails closed instead of reading an empty Postgres.
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
        -- Both anchors, as in keyspaceAlive: HSET on a missing seq would create it.
        if redis.call('EXISTS', eKey) == 0 or redis.call('EXISTS', seqKey) == 0 then
          return 0
        end
        redis.call('HSET', seqKey, 'g', '1')
        return 1
      `,
    });

    this.redis.defineCommand("repairMirroredSnapshotHead", {
      numberOfKeys: 7,
      lua: `
        ${PRELUDE}
        local resKey, prepKey, quarantineKey = KEYS[5], KEYS[6], KEYS[7]
        local observed, id = ARGV[1], ARGV[2]
        if not keyspaceAlive() then return 0 end
        if redis.call('HGET', seqKey, 'sv') ~= '${SNAPSHOT_STATE_VERSION}' then return 0 end
        if redis.call('GET', resKey) ~= 'mirrored' then return 0 end
        if redis.call('EXISTS', prepKey) == 1 or redis.call('EXISTS', quarantineKey) == 1 then return 0 end
        if (redis.call('GET', curKey) or '') ~= observed then return 0 end
        if redis.call('HGET', seqKey, 't') == '1' then return 0 end
        -- Never replace a non-empty head or build an entry from a Postgres row.
        if observed ~= '' or redis.call('HEXISTS', eKey, id) == 0 then return 0 end
        if not redis.call('ZSCORE', idxKey, id) then return 0 end
        redis.call('SET', curKey, id)
        return 1
      `,
    });

    this.redis.defineCommand("appendSnapshotEntry", {
      numberOfKeys: 5,
      lua: `
        ${PRELUDE}
        -- A separate key, not a seq field, because a redis-primary marker must never take the
        -- terminal TTL. applyEntry expires a mirrored marker with the state.
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
        local distinctJson = ARGV[14]
        local markGaps    = ARGV[15] == '1'
        -- Written to the res key on a birth only. Empty for a transition.
        local birthMode   = ARGV[16] or ''

        -- Checking e alone would let a late transition recreate seq with no TTL and restart it at
        -- 1.
        if kind == 'transition' and not keyspaceAlive() then
          return { '${SKIPPED}' }
        end

        -- A retry must not overwrite an entry. Checked before the CAS: a present id is this retry.
        local prior = redis.call('HGET', eKey, id .. '#s')
        if prior then
          if markGaps then
            redis.call('HSET', seqKey, 'g', '1')
          end
          return { '${DUPLICATE}', prior }
        end

        -- Gated on a flag, not on expectedCur ~= '', so asserting an empty cur is still checked.
        if casEnabled then
          local actual = redis.call('GET', curKey)
          if (actual or '') ~= expectedCur then
            -- A fork means the head disagrees with Postgres, so the keyspace is marked gapped.
            redis.call('HSET', seqKey, 'g', '1')
            return { '${FORKED}', actual or '' }
          end
        end



        -- A lost idx would be recreated holding only this entry, and a window read would serve it
        -- as the whole range. Mark the gap and keep the head moving; refusing would freeze the
        -- head.
        if kind == 'transition' and redis.call('EXISTS', idxKey) == 0 then
          redis.call('HSET', seqKey, 'g', '1')
        end

        local r = applyEntry(kind, id, raw, isValid, isTerminal, ttlMs, cycleMode, cycleSeqIn, orderJson, records, orderCount, distinctJson, birthMode)
        return { '${WRITTEN}', tostring(r[1]), tostring(r[2]), r[3], tostring(r[4]) }
      `,
    });

    // See prepare(). The pending stream shares the run's {pNNN} slot, so the unit and its stream
    // entry are written in one script.
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

        -- One pending unit per run. The same token never XADDs twice.
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

        -- Checked here so it is atomic with the store. prepare() checks the rest of the chain.
        if firstGuarded then
          local actual = redis.call('GET', curKey) or ''
          if actual ~= firstExpectedCur then
            -- Do NOT mark the keyspace gapped. The losing transaction rolls back, and the winner's
            -- head stays valid; a gap mark would strand it.
            return { 'forkGuard', 'head', actual }
          end
        end

        redis.call('HSET', prepKey, 'token', token, 'unit', unitJson, 'staged', stagedJson)
        local sid = redis.call('XADD', pendingKey, '*', 'runId', runId, 'transitionToken', token)
        redis.call('HSET', prepKey, 'sid', sid)
        return { 'prepared', sid }
      `,
    });

    // See finalize().
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
        -- A non-birth unit needs a live, version-compatible base. Otherwise a late finalize would
        -- build a partial history with no state version. Apply nothing and leave the unit for
        -- recovery.
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

    // See abortPrepared().
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

    // See quarantinePreparedUnit(). The stream entry is left for the recovery sweep to settle.
    this.redis.defineCommand("quarantinePreparedUnit", {
      numberOfKeys: 2,
      lua: `
        local quarantineKey = KEYS[1]
        local prepKey = KEYS[2]
        -- Already settled. Never write a permanent fail-closed record for a healthy run.
        if redis.call('EXISTS', prepKey) == 0 then
          return 0
        end
        -- Another token means a newer unit holds the slot. A quarantine record would fail every
        -- read of the run forever, so decline. A missing token is a corrupt unit, so record it.
        local tok = redis.call('HGET', prepKey, 'token')
        if tok and tok ~= ARGV[4] then
          return 0
        end
        redis.call('HSET', quarantineKey, 'unit', ARGV[1], 'reason', ARGV[2], 'quarantinedAt', ARGV[3])
        if ARGV[5] == '1' then
          redis.call('HSET', quarantineKey, 'raw', ARGV[6])
        end
        -- A corrupt unit with no token keeps its prep key for inspection.
        if tok then
          redis.call('DEL', prepKey)
          return 1
        end
        return 0
      `,
    });

    this.redis.defineCommand("readPendingState", {
      numberOfKeys: 2,
      lua: `
        return { redis.call('EXISTS', KEYS[1]), redis.call('EXISTS', KEYS[2]) }
      `,
    });

    this.redis.defineCommand("dropSnapshotRun", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local cycles = tonumber(redis.call('HGET', seqKey, 'c') or '0')
        for i = 1, cycles do
          redis.call('DEL', wpKey(i))
        end

        -- seq can be gone, and cycle keys can be sparse, so probe a bounded range with no early
        -- exit. Nothing else deletes a leftover cycle key.
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
        if not keyspaceAlive() or gapped() then return nil end
        local id = ARGV[1]
        local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
        if not vals[1] then return nil end
        -- Coerce every element: a Lua false truncates the returned array.
        return { id, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]), distinctFor(vals[3]), danglingFor(vals[3]) }
      `,
    });

    this.redis.defineCommand("readLatestSnapshot", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        if not keyspaceAlive() or gapped() then return nil end
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
        -- Not present, so the read fails closed. An empty set would read as authoritative.
        if not keyspaceAlive() or gapped() then return { '0', '' } end
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
        -- Not present, so the read fails closed. An empty set would read as authoritative.
        if not keyspaceAlive() or gapped() then return { '0', '', '', '0', '' } end
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

        -- No keyspace or a lost idx is a MISS, so the redis-primary caller fails closed. A lost idx
        -- would otherwise give an empty HIT on every poll. A live keyspace with nothing newer is an
        -- empty HIT.
        if not keyspaceAlive() or redis.call('EXISTS', idxKey) == 0 then return nil end

        -- A gapped keyspace is refused for the same reason: a short window would look complete.
        if redis.call('HGET', seqKey, 'g') == '1' then return nil end

        -- STRICTLY after the cursor, so same-millisecond entries are dropped, exactly as the
        -- Postgres query (createdAt > cursor) drops them. createdAt is fixed-width ISO UTC, so a
        -- string compare is a time compare. Walking newest-first stops the scan at the cursor, so
        -- its cost is the answer's length, not the history's.
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
          -- The cycle key can expire before the entry. Without this flag an empty order looks like
          -- "no indexed waitpoints", so a batched resume loses every position instead of failing
          -- closed.
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

        -- Same MISS and gap gates as readSnapshotsSinceCreatedAt.
        if not keyspaceAlive() or redis.call('EXISTS', idxKey) == 0 then return nil end

        if redis.call('HGET', seqKey, 'g') == '1' then return nil end

        -- idx holds valid entries only, so an invalid since id falls back to its '#s' field.
        local score = redis.call('ZSCORE', idxKey, sinceId)
        if not score then
          score = redis.call('HGET', eKey, sinceId .. '#s')
          if not score then return nil end
        end

        -- Env scoping uses the since entry, not the window.
        local sinceRaw = redis.call('HGET', eKey, sinceId) or ''

        -- Newest-first with a limit, reversed app-side, to match the engine's Postgres window.
        local ids = redis.call('ZREVRANGEBYSCORE', idxKey, '+inf', '(' .. score, 'LIMIT', 0, limit)
        if #ids == 0 then return { sinceRaw, '' } end

        -- The head is the newest entry with a body. Its cycle is read after the loop, so a dropped
        -- row cannot donate its cycle data to the next one.
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
          -- The cycle key can expire before the entry. Without this flag an empty order looks like
          -- "no indexed waitpoints", so a batched resume loses every position instead of failing
          -- closed.
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

  // One command writes both fields, so a missing `distinct` beside a non-empty `order` is corrupt.
  // Rebuilding it from `order` would silently drop unindexed waits. Report not present, so the
  // read fails closed.
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
    repairMirroredSnapshotHead(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
      resKey: string,
      prepKey: string,
      quarantineKey: string,
      observedCur: string,
      id: string,
      callback?: Callback<number>
    ): Result<number, Context>;
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
    quarantinePreparedUnit(
      quarantineKey: string,
      prepKey: string,
      unitJson: string,
      reason: string,
      quarantinedAt: string,
      expectedToken: string,
      hasRaw: string,
      rawValue: string,
      callback?: Callback<number>
    ): Result<number, Context>;
    readPendingState(
      prepKey: string,
      quarantineKey: string,
      callback?: Callback<[number, number]>
    ): Result<[number, number], Context>;
  }
}
