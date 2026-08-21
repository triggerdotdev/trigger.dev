import {
  createRedisClient,
  type Callback,
  type Redis,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";

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

// isValid is derived, never stored, so the entry JSON stays byte-identical to the caller's document.
export function isValidFor(entry: { error?: unknown }): boolean {
  return !entry.error;
}

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
  cycle?: { cycleSeq: number; count: number };
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
      | { kind: "new"; completedWaitpoints: CompletedWaitpointRef[]; records?: string }
      | { kind: "carryForward"; cycleSeq: number };
  }): Promise<AppendResult> {
    return this.#timed("append", async () => {
      const k = snapshotKeys(args.entry.runId);
      const raw = JSON.stringify(args.entry);
      const valid = isValidFor(args.entry);

      let cycleMode = "none";
      let cycleSeqIn = "0";
      let orderJson = "";
      let records = "";
      let orderCount = "0";
      if (args.cycle?.kind === "new") {
        const order = deriveOrder(args.cycle.completedWaitpoints);
        cycleMode = "new";
        orderJson = JSON.stringify(order);
        records = args.cycle.records ?? "";
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
        args.expectedCur !== undefined ? "1" : "0"
      )) as string[];

      return this.#interpretAppend(reply, raw, orderJson);
    });
  }

  #interpretAppend(reply: string[], raw: string, orderJson: string): AppendResult {
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
    this.#observeSizes(raw, orderJson, cycleSeq);
    this.metrics?.recordAppend("written", ttl);
    return {
      outcome: "written",
      seq,
      ...(cycleSeq > 0 ? { cycleSeq } : {}),
      ttl,
      cycleMismatch,
    };
  }

  #observeSizes(raw: string, orderJson: string, cycleSeq: number): void {
    const entryBytes = Buffer.byteLength(raw, "utf8");
    this.metrics?.recordEntryBytes(entryBytes);
    if (this.highWater.entryBytes !== undefined && entryBytes > this.highWater.entryBytes) {
      this.logger.warn("RedisSnapshotStore entry above high-water mark", { entryBytes });
    }
    if (orderJson !== "") {
      const cycleBytes = Buffer.byteLength(orderJson, "utf8");
      this.metrics?.recordCycleKeyBytes(cycleBytes);
      if (this.highWater.cycleKeyBytes !== undefined && cycleBytes > this.highWater.cycleKeyBytes) {
        this.logger.warn("RedisSnapshotStore cycle key above high-water mark", { cycleBytes });
      }
    }
    if (cycleSeq > 0) {
      this.metrics?.recordCycleCount(cycleSeq);
      if (this.highWater.cycleCount !== undefined && cycleSeq > this.highWater.cycleCount) {
        this.logger.warn("RedisSnapshotStore cycle count above high-water mark", { cycleSeq });
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
      return this.#decode(reply, opts?.environmentId);
    });
  }

  async getLatest(runId: string, opts?: { environmentId?: string }): Promise<SnapshotRead | null> {
    return this.#timed("getLatest", async () => {
      const k = snapshotKeys(runId);
      const reply = await this.redis.readLatestSnapshot(k.e, k.idx, k.cur, k.seq);
      return this.#decode(reply, opts?.environmentId);
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
      return decodeWaitpointIds(reply[0] === "1", reply[1] ?? "");
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

      const headOrder = reply[0] ?? "";
      const rows: SnapshotRead[] = [];
      for (let i = 1; i + 3 < reply.length + 1; i += 4) {
        const decoded = this.#decode(
          [reply[i], reply[i + 1], reply[i + 2], reply[i + 3], ""],
          opts?.environmentId
        );
        if (decoded) rows.push(decoded);
      }

      // The since id itself is env-scoped in the engine, so a foreign environment must miss rather
      // than return an empty hit: an empty hit would read as "nothing new", not "not found".
      if (opts?.environmentId !== undefined && rows.length === 0 && reply.length > 1) {
        return { kind: "miss" };
      }

      rows.reverse();
      const head = rows[rows.length - 1];
      const headWaitpointIds = decodeWaitpointIds(head !== undefined, headOrder);
      if (head) {
        head.completedWaitpointIds = headWaitpointIds;
      }
      for (const row of rows.slice(0, -1)) {
        delete row.completedWaitpointIds;
      }
      return { kind: "hit", entries: rows, headWaitpointIds };
    });
  }

  // [id, raw, seq, pointer, order] -> SnapshotRead. The environment compare is app-side, per the
  // plan: the store returns null for a foreign environment and the 404 throw stays in the engine.
  #decode(reply: string[] | null, environmentId?: string): SnapshotRead | null {
    if (!reply || reply.length === 0) return null;
    const [id, raw, seqStr, pointer, orderJson] = reply;
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
      read.completedWaitpointIds = decodeWaitpointIds(true, orderJson);
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

        -- Liveness is TWO anchors: e and seq. All keys get the same PEXPIRE but expire independently
        -- (or seq can vanish under maxmemory eviction while e survives), so checking e alone lets a
        -- late transition recreate seq with no TTL and restart it at 1 beside a surviving idx. A
        -- birth always creates both in this same script, so this never rejects a live keyspace.
        if kind == 'transition' and (redis.call('EXISTS', eKey) == 0 or redis.call('EXISTS', seqKey) == 0) then
          return { '${SKIPPED}' }
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

        -- Append-only: a retried append (eg. ioredis reconnect-and-retry on a READONLY/UNBLOCKED
        -- reply error) must not overwrite an existing entry's bytes or rescore it in idx.
        local prior = redis.call('HGET', eKey, id .. '#s')
        if prior then
          return { '${DUPLICATE}', prior }
        end

        local seq = redis.call('HINCRBY', seqKey, 'e', 1)

        local cycleSeq = 0
        local mismatch = 0
        if cycleMode == 'new' then
          -- The STORE mints cycleSeq, so the sequence is dense by construction and the terminal
          -- PEXPIRE loop from 1..c is correct.
          cycleSeq = redis.call('HINCRBY', seqKey, 'c', 1)
          redis.call('HSET', wpKey(cycleSeq), 'order', orderJson, 'count', orderCount)
          if records ~= '' then
            redis.call('HSET', wpKey(cycleSeq), 'records', records)
          end
        elseif cycleMode == 'carry' then
          cycleSeq = cycleSeqIn
          local c = redis.call('HGET', wpKey(cycleSeq), 'count')
          if not c then
            mismatch = 1
          else
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
        return { id, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]) }
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
        return { cur, vals[1], vals[2] or '', vals[3] or '', orderFor(vals[3]) }
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
        return { '1', orderFor(pointer) }
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

        -- NEWEST-first with a limit, then reversed app-side. The engine reads createdAt desc /
        -- take N / reverse, so the oldest-first form would return the wrong window entirely.
        local ids = redis.call('ZREVRANGEBYSCORE', idxKey, '+inf', '(' .. score, 'LIMIT', 0, limit)
        if #ids == 0 then return { '' } end

        -- The head is the newest entry, and it is the ONLY one whose cycle key is read. That makes
        -- head-only hydration structural: the tail's cycle keys are never touched.
        local out = { orderFor(redis.call('HGET', eKey, ids[1] .. '#c')) }
        for i = 1, #ids do
          local id = ids[i]
          local vals = redis.call('HMGET', eKey, id, id .. '#s', id .. '#c')
          out[#out + 1] = id
          out[#out + 1] = vals[1] or ''
          out[#out + 1] = vals[2] or ''
          out[#out + 1] = vals[3] or ''
        end
        return out
      `,
    });
  }
}

export function decodeWaitpointIds(present: boolean, orderJson: string): WaitpointIds {
  const order: string[] = orderJson === "" ? [] : (JSON.parse(orderJson) as string[]);
  return { present, distinctIds: [...new Set(order)], order };
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
