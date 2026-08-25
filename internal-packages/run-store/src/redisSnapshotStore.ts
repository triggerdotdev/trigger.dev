import {
  createRedisClient,
  type Callback,
  type Redis,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import type { CompletedWaitpoint } from "@trigger.dev/core/v3/schemas";

export type SnapshotKeys = { e: string; idx: string; cur: string; seq: string };

// All four core keys plus every snap:{runId}:wp:<n> key share the {runId} hash tag, so a run's whole
// state sits in one cluster slot and every mutation is one atomic script.
export function snapshotKeys(runId: string): SnapshotKeys {
  const base = `snap:{${runId}}`;
  return { e: `${base}:e`, idx: `${base}:idx`, cur: `${base}:cur`, seq: `${base}:seq` };
}

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

export type SnapshotStoreMetrics = {
  recordAppend(outcome: string, ttl: string): void;
  recordEntryBytes(bytes: number): void;
  recordCycleKeyBytes(bytes: number): void;
  recordCycleCount(count: number): void;
  recordSkippedNoKeyspace(): void;
  recordCycleMismatch(): void;
  recordLatency(op: string, ms: number): void;
};

export type RedisSnapshotStoreOptions = {
  redisOptions: RedisOptions;
  completedTtlMs: number;
  sinceLimit?: number;
  highWater?: { entryBytes?: number; cycleKeyBytes?: number; cycleCount?: number };
  metrics?: SnapshotStoreMetrics;
  logger?: Logger;
};

const SKIPPED = "skipped";
const FORKED = "forked";
const WRITTEN = "written";
const DUPLICATE = "duplicate";

export class RedisSnapshotStore {
  private readonly redis: Redis;
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
    this.redis = createRedisClient(options.redisOptions, {
      onError: (error) => this.logger.error("RedisSnapshotStore redis client error", { error }),
    });
    this.#registerCommands();
  }

  async quit(): Promise<void> {
    // Idempotent and error-swallowing: every test calls this in a `finally`, and a double quit()
    // (or one after a failed connect) must never mask the real assertion failure.
    if (!this.#quit) {
      this.#quit = this.redis.quit().then(
        () => undefined,
        () => undefined
      );
    }
    await this.#quit;
  }

  async #timed<T>(op: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      this.metrics?.recordLatency(op, Date.now() - started);
    }
  }

  async append(args: {
    entry: SnapshotEntryInput;
    kind: "birth" | "transition";
    isTerminal: boolean;
    expectedCur?: string;
    cycle?:
      | {
          kind: "new";
          completedWaitpoints: CompletedWaitpointRef[];
          records?: CompletedWaitpointRecord[];
        }
      | { kind: "carryForward"; cycleSeq: number };
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
      }

      const reply = (await this.redis.appendSnapshotEntry(
        k.e,
        k.idx,
        k.cur,
        k.seq,
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
        distinctJson
      )) as string[];

      return this.#interpretAppend(reply, raw, orderJson, records, args.entry.runId);
    });
  }

  #interpretAppend(
    reply: string[],
    raw: string,
    orderJson: string,
    records: string,
    runId: string
  ): AppendResult {
    if (reply[0] === SKIPPED) {
      this.metrics?.recordSkippedNoKeyspace();
      this.metrics?.recordAppend("skippedNoKeyspace", "none");
      return { outcome: "skippedNoKeyspace" };
    }
    if (reply[0] === FORKED) {
      this.metrics?.recordAppend("forked", "none");
      return { outcome: "forked", actualCur: reply[1] ?? "" };
    }
    if (reply[0] === DUPLICATE) {
      this.metrics?.recordAppend("duplicate", "none");
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
    this.metrics?.recordAppend("written", ttl);
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
      return decodeWaitpointIds(reply[0] === "1", reply[1] ?? "", reply[2] ?? "");
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
      const rows: SnapshotRead[] = [];
      // Tracks whether the Lua-chosen head row (always the first, i === 2) itself survives the
      // env filter below -- headOrder must never be attributed to a different, surviving row.
      let headSurvived = false;
      for (let i = 3; i + 3 < reply.length; i += 4) {
        // orderKnown is false here: headOrder covers only the head row, resolved separately below.
        const decoded = this.#decode(
          [reply[i], reply[i + 1], reply[i + 2], reply[i + 3], ""],
          opts?.environmentId,
          runId,
          false
        );
        if (decoded) {
          rows.push(decoded);
          if (i === 3) headSurvived = true;
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
      const rows: SnapshotRead[] = [];
      // Tracks whether the Lua-chosen head row (always the first, i === 2) survives the env filter,
      // so headOrder is never attributed to a different, surviving row.
      let headSurvived = false;
      for (let i = 3; i + 3 < reply.length; i += 4) {
        const decoded = this.#decode(
          [reply[i], reply[i + 1], reply[i + 2], reply[i + 3], ""],
          opts?.environmentId,
          runId,
          false
        );
        if (decoded) {
          rows.push(decoded);
          if (i === 3) headSurvived = true;
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
    const [id, raw, seqStr, pointer, orderJson, distinctJson] = reply;
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
      local function orderFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'order') or ''
      end
      -- The complete id set, which is NOT the order deduped: order holds only batch-indexed ids.
      local function distinctFor(pointer)
        if not pointer then return '' end
        local cs = string.match(pointer, '^(%d+):')
        if not cs then return '' end
        return redis.call('HGET', wpKey(cs), 'distinct') or ''
      end
    `;

    this.redis.defineCommand("appendSnapshotEntry", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
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

        -- Liveness is TWO anchors: e and seq. All keys get the same PEXPIRE but expire independently
        -- (or seq can vanish under maxmemory eviction while e survives), so checking e alone lets a
        -- late transition recreate seq with no TTL and restart it at 1 beside a surviving idx. A
        -- birth always creates both in this same script, so this never rejects a live keyspace.
        if kind == 'transition' and (redis.call('EXISTS', eKey) == 0 or redis.call('EXISTS', seqKey) == 0) then
          return { '${SKIPPED}' }
        end

        -- Append-only: a retried append must not overwrite an existing entry. Checked BEFORE the
        -- CAS below -- a present id can only be this same retry, never a competitor's write.
        local prior = redis.call('HGET', eKey, id .. '#s')
        if prior then
          return { '${DUPLICATE}', prior }
        end

        -- Optional compare-and-set on cur, checked BEFORE any mutation. Gated on an explicit flag
        -- (not on expectedCur ~= ''), so a caller asserting cur is unset (expectedCur = '') still
        -- gets a real check instead of silently skipping it.
        if casEnabled then
          local actual = redis.call('GET', curKey)
          if (actual or '') ~= expectedCur then
            return { '${FORKED}', actual or '' }
          end
        end

        local seq = redis.call('HINCRBY', seqKey, 'e', 1)

        local cycleSeq = 0
        local mismatch = 0
        if cycleMode == 'new' then
          -- The STORE mints cycleSeq, so the sequence is dense by construction and the terminal
          -- PEXPIRE loop from 1..c is correct.
          cycleSeq = redis.call('HINCRBY', seqKey, 'c', 1)
          redis.call('HSET', wpKey(cycleSeq), 'order', orderJson, 'count', orderCount, 'distinct', distinctJson)
          if records ~= '' then
            redis.call('HSET', wpKey(cycleSeq), 'records', records)
          else
            -- A new cycle owns the whole key: a lost seq counter can re-mint a cycleSeq whose key
            -- still holds another cycle's records, and order/count stay mutually consistent so the
            -- mismatch check cannot see it. No-op on a fresh key.
            redis.call('HDEL', wpKey(cycleSeq), 'records')
          end
        elseif cycleMode == 'carry' then
          -- Attach a pointer only if this incarnation actually minted the cycle. seq can be
          -- evicted while a wp:<n> key survives, so a bare key-exists check would adopt a dead
          -- incarnation's order and records under a consistent count, invisibly.
          local minted = tonumber(redis.call('HGET', seqKey, 'c') or '0')
          local c = redis.call('HGET', wpKey(cycleSeqIn), 'count')
          if not c or minted < cycleSeqIn then
            mismatch = 1
          else
            cycleSeq = cycleSeqIn
            orderCount = c
          end
        end

        redis.call('HSET', eKey, id, raw, id .. '#s', seq)
        if cycleSeq > 0 then
          redis.call('HSET', eKey, id .. '#c', cycleSeq .. ':' .. orderCount)
        end

        -- idx indexes VALID entries only, which makes the since-cap exact. An invalid entry is still
        -- reachable by id, and its seq is still readable from its own '#s' field. ZADD before SET cur
        -- because Redis never rolls back a partially applied script: if a later call in this script
        -- errored, having idx already written is the recoverable half of the pair.
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
          if isTerminal and not wasTerminal then
            ttl = 'completion'
          else
            ttl = 'reapplied'
          end
        end

        return { '${WRITTEN}', tostring(seq), tostring(cycleSeq), ttl, tostring(mismatch) }
      `,
    });

    this.redis.defineCommand("readSnapshotById", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local id = ARGV[1]
        local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
        if not vals[1] then return nil end
        -- Coerce every element: a Lua false TRUNCATES the returned array at that position.
        return { id, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]), distinctFor(vals[3]) }
      `,
    });

    this.redis.defineCommand("readLatestSnapshot", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local cur = redis.call('GET', curKey)
        if not cur then return nil end
        local vals = redis.call('HMGET', eKey, cur, cur .. '#s', cur .. '#c')
        if not vals[1] then return nil end
        return { cur, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]), distinctFor(vals[3]) }
      `,
    });

    this.redis.defineCommand("readSnapshotWaitpointIds", {
      numberOfKeys: 4,
      lua: `
        ${PRELUDE}
        local id = ARGV[1]
        if redis.call('HEXISTS', eKey, id) == 0 then
          return { '0', '' }
        end
        local pointer = redis.call('HGET', eKey, id .. '#c')
        return { '1', orderFor(pointer), distinctFor(pointer) }
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
        if redis.call('EXISTS', eKey) == 0 or redis.call('EXISTS', idxKey) == 0 then return nil end

        -- STRICTLY greater than the cursor, and same-millisecond entries are dropped. Postgres
        -- serves this window with createdAt > cursor and drops them too; a Redis read that is more
        -- correct than the Postgres read shows up as divergence in compare mode.
        --
        -- createdAt is always toISOString() output, one fixed-width UTC format, so a lexicographic
        -- compare is a chronological compare. Walking newest-first lets the scan stop at the first
        -- entry at or before the cursor, which makes its length the length of the ANSWER rather
        -- than the length of the run's history.
        local out = { '', '', '' }
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
        local out = { sinceRaw, '', '' }
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
    appendSnapshotEntry(
      eKey: string,
      idxKey: string,
      curKey: string,
      seqKey: string,
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
  }
}
