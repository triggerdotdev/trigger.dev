import { randomUUID } from "node:crypto";
import type { RunMetadataChangeOperation } from "@trigger.dev/core/v3";
import type { Result } from "ioredis";
import { getMeter, type Counter, type Meter } from "@internal/tracing";
import type { RedisClient } from "~/redis.server";

export type BufferedRunMetadataChangeOperation = {
  runId: string;
  timestamp: number;
  operation: RunMetadataChangeOperation;
  /** Set on operations held in a fallback buffer until they are handed to the primary under this ingest id. */
  ingestId?: string;
};

/**
 * A write a drainer started for a run without learning whether it committed: the run's
 * `metadataVersion` it expected, and how many of the buffered operations (from the front) it wrote.
 */
export type PendingMetadataWrite = {
  metadataVersion: number;
  count: number;
};

/** A run's buffered operations, claimed for draining until `ack`, `requeue` or `abandon`. */
export type MetadataBufferClaim = {
  runId: string;
  operations: BufferedRunMetadataChangeOperation[];
  pendingWrite?: PendingMetadataWrite;
};

/** Holds parent/root metadata operations between flushes of the batched metadata flusher. */
/**
 * `ingestId` identifies one logical ingest; repeating it records the operations once.
 * `enforceCap: false` skips the per-run cap, for operations that were already accepted elsewhere.
 */
export type MetadataIngestOptions = { ingestId?: string; enforceCap?: boolean };

export type MetadataOperationBuffer = {
  ingest(
    runId: string,
    operations: BufferedRunMetadataChangeOperation[],
    options?: MetadataIngestOptions
  ): Promise<void>;
  /** Claims up to `batchSize` runs that are due. `includeNotYetDue` claims every pending run. */
  claimDue(
    batchSize: number,
    options?: { includeNotYetDue?: boolean }
  ): Promise<MetadataBufferClaim[]>;
  /**
   * Records that all claimed operations are about to be written at `metadataVersion`, so a later
   * claim can tell whether that write committed. Returns false when the claim is no longer held.
   */
  recordPendingWrite(claim: MetadataBufferClaim, metadataVersion: number): Promise<boolean>;
  /** Drops the first `count` claimed operations (default: all), clears the pending write and releases the claim. */
  ack(claim: MetadataBufferClaim, options?: { count?: number }): Promise<void>;
  /** Keeps the operations, reschedules the run and releases the claim. */
  requeue(claim: MetadataBufferClaim, options?: { keepPendingWrite?: boolean }): Promise<void>;
  /** Forgets a claim this process no longer holds. */
  abandon(claim: MetadataBufferClaim): void;
  /** Number of runs with pending operations. */
  size(): Promise<number>;
  /** False when a command would not be sent right now (for example, while reconnecting). */
  isAvailable(): boolean;
  /** True when this buffer holds operations for the run that have not been claimed. */
  hasPendingRun?(runId: string): boolean;
};

const INGEST_DEDUPE_TTL_MS = 10 * 60 * 1000;

const DEFAULT_MAX_PENDING_OPERATIONS_PER_RUN = 1_000;

/** Thrown by `ingest` when a run already holds the maximum number of buffered operations. */
export class MetadataBufferFullError extends Error {
  constructor(runId: string, max: number) {
    super(`Run ${runId} already has ${max} buffered metadata operations`);
    this.name = "MetadataBufferFullError";
  }
}

/** Process-local buffer. Operations are lost when the process exits. */
export class InMemoryMetadataOperationBuffer implements MetadataOperationBuffer {
  private readonly _buffer = new Map<string, BufferedRunMetadataChangeOperation[]>();
  private readonly _pendingWrites = new Map<string, PendingMetadataWrite>();
  private readonly _claimed = new Map<string, number>();
  private readonly _ingestIds = new Map<string, number>();
  private readonly maxPendingOperationsPerRun: number;

  constructor(options?: { maxPendingOperationsPerRun?: number }) {
    this.maxPendingOperationsPerRun =
      options?.maxPendingOperationsPerRun ?? DEFAULT_MAX_PENDING_OPERATIONS_PER_RUN;
  }

  async ingest(
    runId: string,
    operations: BufferedRunMetadataChangeOperation[],
    options?: MetadataIngestOptions
  ): Promise<void> {
    const ingestId = options?.ingestId;
    if (ingestId) {
      this.#expireIngestIds();
      if (this._ingestIds.has(ingestId)) return;
    }
    const tagged = ingestId ? operations.map((op) => ({ ...op, ingestId })) : operations;
    const existing = this._buffer.get(runId) ?? [];
    const pending = existing.length + (this._claimed.get(runId) ?? 0) + tagged.length;
    if (
      options?.enforceCap !== false &&
      this.maxPendingOperationsPerRun > 0 &&
      pending > this.maxPendingOperationsPerRun
    ) {
      throw new MetadataBufferFullError(runId, this.maxPendingOperationsPerRun);
    }
    if (ingestId) {
      this._ingestIds.set(ingestId, Date.now() + INGEST_DEDUPE_TTL_MS);
    }
    this._buffer.set(runId, [...existing, ...tagged]);
  }

  async claimDue(batchSize: number): Promise<MetadataBufferClaim[]> {
    const claims: MetadataBufferClaim[] = [];
    for (const runId of [...this._buffer.keys()]) {
      if (claims.length >= batchSize) break;
      const operations = this._buffer.get(runId)!;
      this._buffer.delete(runId);
      this._claimed.set(runId, operations.length);
      claims.push({ runId, operations, pendingWrite: this._pendingWrites.get(runId) });
    }
    return claims;
  }

  async recordPendingWrite(claim: MetadataBufferClaim, metadataVersion: number): Promise<boolean> {
    this._pendingWrites.set(claim.runId, { metadataVersion, count: claim.operations.length });
    return true;
  }

  async ack(claim: MetadataBufferClaim, options?: { count?: number }): Promise<void> {
    this._pendingWrites.delete(claim.runId);
    this._claimed.delete(claim.runId);
    const count = options?.count ?? claim.operations.length;
    if (count < claim.operations.length) {
      this.#putBack(claim.runId, claim.operations.slice(count));
    }
  }

  async requeue(
    claim: MetadataBufferClaim,
    options?: { keepPendingWrite?: boolean }
  ): Promise<void> {
    if (!options?.keepPendingWrite) {
      this._pendingWrites.delete(claim.runId);
    }
    const stillClaimed = (this._claimed.get(claim.runId) ?? 0) - claim.operations.length;
    if (stillClaimed > 0) {
      this._claimed.set(claim.runId, stillClaimed);
    } else {
      this._claimed.delete(claim.runId);
    }
    this.#putBack(claim.runId, claim.operations);
  }

  abandon(_claim: MetadataBufferClaim): void {}

  async size(): Promise<number> {
    return this._buffer.size;
  }

  isAvailable(): boolean {
    return true;
  }

  hasPendingRun(runId: string): boolean {
    return this._buffer.has(runId);
  }

  #expireIngestIds() {
    const now = Date.now();
    for (const [id, expiresAt] of this._ingestIds) {
      if (expiresAt > now) break;
      this._ingestIds.delete(id);
    }
  }

  #putBack(runId: string, operations: BufferedRunMetadataChangeOperation[]) {
    const existing = this._buffer.get(runId) ?? [];
    this._buffer.set(runId, [...operations, ...existing]);
  }
}

export type FallbackMetadataOperationBufferOptions = {
  primary: MetadataOperationBuffer;
  fallback: MetadataOperationBuffer;
  onFallback?: (action: "ingest" | "claim", error?: unknown) => void;
  meter?: Meter;
};

/**
 * Ingests into `primary`, or into `fallback` when the primary would not send the command at all.
 * A primary failure after the command may have been sent is rethrown, since falling back could
 * apply the same operations twice. Drains both, routing each claim back to its source.
 *
 * A fallback claim holding operations with an ingest id is never applied from the fallback. It is
 * handed to the primary whole and in order once the primary accepts it, through the same ingest
 * that dedupes a retried request, and dropped from the fallback only after that succeeds, so a
 * request retried across the two buffers is applied once. Until then it stays in the fallback, and
 * the primary's operations for that run are not drained ahead of it. Operations covered by a
 * pending-write fence are processed locally first.
 */
export class FallbackMetadataOperationBuffer implements MetadataOperationBuffer {
  private readonly primary: MetadataOperationBuffer;
  private readonly fallback: MetadataOperationBuffer;
  private readonly onFallback?: FallbackMetadataOperationBufferOptions["onFallback"];
  private readonly sources = new WeakMap<MetadataBufferClaim, MetadataOperationBuffer>();
  private readonly fallbackCounter: Counter;

  constructor(options: FallbackMetadataOperationBufferOptions) {
    this.primary = options.primary;
    this.fallback = options.fallback;
    this.onFallback = options.onFallback;
    this.fallbackCounter = (options.meter ?? getMeter("metadata-flush")).createCounter(
      "metadata.buffer.fallbacks",
      {
        description: "Primary metadata buffer failures served by the fallback buffer, by action",
      }
    );
  }

  async ingest(
    runId: string,
    operations: BufferedRunMetadataChangeOperation[],
    options?: MetadataIngestOptions
  ): Promise<void> {
    if (this.primary.isAvailable()) {
      await this.primary.ingest(runId, operations, options);
      return;
    }
    this.#recordFallback("ingest");
    await this.fallback.ingest(runId, operations, options);
  }

  async claimDue(
    batchSize: number,
    options?: { includeNotYetDue?: boolean }
  ): Promise<MetadataBufferClaim[]> {
    const claimedFromFallback = await this.fallback.claimDue(batchSize, options);
    const fallbackClaims: MetadataBufferClaim[] = [];
    for (const claim of claimedFromFallback) {
      const reconciled = await this.#reconcile(claim);
      if (reconciled) fallbackClaims.push(reconciled);
    }
    this.#track(fallbackClaims, this.fallback);

    if (fallbackClaims.length >= batchSize) {
      return fallbackClaims;
    }

    let primaryClaims: MetadataBufferClaim[] = [];
    if (!this.primary.isAvailable()) {
      this.#recordFallback("claim");
    } else {
      try {
        primaryClaims = await this.primary.claimDue(batchSize - fallbackClaims.length, options);
      } catch (error) {
        this.#recordFallback("claim", error);
      }
    }
    const behindFallback = primaryClaims.filter((claim) =>
      this.fallback.hasPendingRun?.(claim.runId)
    );
    for (const claim of behindFallback) {
      try {
        await this.primary.requeue(claim, { keepPendingWrite: true });
      } catch (error) {
        this.#recordFallback("claim", error);
        this.primary.abandon(claim);
      }
    }
    primaryClaims = primaryClaims.filter((claim) => !behindFallback.includes(claim));
    this.#track(primaryClaims, this.primary);

    return [...fallbackClaims, ...primaryClaims];
  }

  recordPendingWrite(claim: MetadataBufferClaim, metadataVersion: number): Promise<boolean> {
    return this.#source(claim).recordPendingWrite(claim, metadataVersion);
  }

  ack(claim: MetadataBufferClaim, options?: { count?: number }): Promise<void> {
    return this.#source(claim).ack(claim, options);
  }

  requeue(claim: MetadataBufferClaim, options?: { keepPendingWrite?: boolean }): Promise<void> {
    return this.#source(claim).requeue(claim, options);
  }

  abandon(claim: MetadataBufferClaim): void {
    this.#source(claim).abandon(claim);
  }

  async size(): Promise<number> {
    const fallback = await this.fallback.size();
    if (!this.primary.isAvailable()) return fallback;
    return fallback + (await this.primary.size());
  }

  isAvailable(): boolean {
    return true;
  }

  async #reconcile(claim: MetadataBufferClaim): Promise<MetadataBufferClaim | undefined> {
    if (!claim.operations.some((op) => op.ingestId)) return claim;

    if (claim.pendingWrite) {
      const fenced = claim.operations.slice(0, claim.pendingWrite.count);
      const rest = claim.operations.slice(claim.pendingWrite.count);
      if (rest.length > 0) {
        await this.fallback.requeue(
          { runId: claim.runId, operations: rest },
          { keepPendingWrite: true }
        );
      }
      return { ...claim, operations: fenced.map(withoutIngestId) };
    }

    if (!this.primary.isAvailable()) {
      this.fallbackCounter.add(1, { action: "held" });
      await this.fallback.requeue(claim, { keepPendingWrite: true });
      return undefined;
    }

    let generatedId: string | undefined;
    for (const op of claim.operations) {
      if (op.ingestId) {
        generatedId = undefined;
        continue;
      }
      generatedId ??= `handoff:${randomUUID()}`;
      op.ingestId = generatedId;
    }

    const groups: { ingestId: string; operations: BufferedRunMetadataChangeOperation[] }[] = [];
    for (const op of claim.operations) {
      const last = groups.at(-1);
      if (last && last.ingestId === op.ingestId) {
        last.operations.push(op);
      } else {
        groups.push({ ingestId: op.ingestId!, operations: [op] });
      }
    }

    for (let index = 0; index < groups.length; index++) {
      const { ingestId, operations } = groups[index];
      try {
        await this.primary.ingest(claim.runId, operations.map(withoutIngestId), {
          ingestId,
          enforceCap: false,
        });
        this.fallbackCounter.add(operations.length, { action: "handed_off" });
      } catch (error) {
        this.#recordFallback("claim", error);
        this.fallbackCounter.add(1, { action: "held" });
        await this.fallback.requeue(
          { runId: claim.runId, operations: groups.slice(index).flatMap((g) => g.operations) },
          { keepPendingWrite: true }
        );
        await this.fallback.ack({ runId: claim.runId, operations: [] });
        return undefined;
      }
    }

    await this.fallback.ack({ runId: claim.runId, operations: [] });
    return undefined;
  }

  #recordFallback(action: "ingest" | "claim", error?: unknown) {
    this.fallbackCounter.add(1, { action });
    this.onFallback?.(action, error);
  }

  #track(claims: MetadataBufferClaim[], source: MetadataOperationBuffer) {
    for (const claim of claims) this.sources.set(claim, source);
  }

  #source(claim: MetadataBufferClaim): MetadataOperationBuffer {
    return this.sources.get(claim) ?? this.primary;
  }
}

function withoutIngestId(
  op: BufferedRunMetadataChangeOperation
): BufferedRunMetadataChangeOperation {
  if (!op.ingestId) return op;
  const { ingestId: _ingestId, ...rest } = op;
  return rest;
}

export type RedisMetadataOperationBufferOptions = {
  redis: RedisClient;
  /** Delay between a run's first buffered operation and its flush. Operations inside the window share one write. */
  flushDelayMs?: number;
  /**
   * Claim lock TTL. A crashed drainer's claim frees up after this. A write still in flight when it
   * expires can race the next owner's write, so it must stay well above the worst-case flush time.
   */
  lockTtlMs?: number;
  /** Delay before a requeued run is retried. */
  requeueBackoffMs?: number;
  /** Most operations a run may hold before further ingests are rejected. */
  maxPendingOperationsPerRun?: number;
  nowMs?: () => number;
  keyPrefix?: string;
};

type StoredOp = { t: number; o: RunMetadataChangeOperation };

type ActiveClaim = { token: string; count: number };

/**
 * Redis-backed buffer that survives restarts and lets one process at a time drain a run.
 *
 * Every key carries the `{metabuf}` hash tag so the scripts can touch them atomically on a cluster.
 * - `<prefix>{metabuf}:ops:<runId>` LIST of JSON operations
 * - `<prefix>{metabuf}:dirty` ZSET of run ids scored by due time
 * - `<prefix>{metabuf}:lock:<runId>` claim token with a PX expiry
 * - `<prefix>{metabuf}:pending:<runId>` `<metadataVersion>:<count>` of a write not yet acknowledged
 * - `<prefix>{metabuf}:ingest:<id>` marks an ingest as applied so a resent command is ignored
 */
export class RedisMetadataOperationBuffer implements MetadataOperationBuffer {
  private readonly redis: RedisClient;
  private readonly flushDelayMs: number;
  private readonly lockTtlMs: number;
  private readonly requeueBackoffMs: number;
  private readonly maxPendingOperationsPerRun: number;
  private readonly now: () => number;
  private readonly prefix: string;
  private readonly active = new Map<string, ActiveClaim>();

  constructor(options: RedisMetadataOperationBufferOptions) {
    this.redis = options.redis;
    this.flushDelayMs = options.flushDelayMs ?? 1000;
    this.lockTtlMs = options.lockTtlMs ?? 30_000;
    this.requeueBackoffMs = options.requeueBackoffMs ?? 1000;
    this.maxPendingOperationsPerRun =
      options.maxPendingOperationsPerRun ?? DEFAULT_MAX_PENDING_OPERATIONS_PER_RUN;
    this.now = options.nowMs ?? Date.now;
    this.prefix = `${options.keyPrefix ?? ""}{metabuf}`;

    this.redis.defineCommand("metabufIngest", { numberOfKeys: 3, lua: INGEST_LUA });
    this.redis.defineCommand("metabufClaim", { numberOfKeys: 4, lua: CLAIM_LUA });
    this.redis.defineCommand("metabufRecordPending", {
      numberOfKeys: 2,
      lua: RECORD_PENDING_LUA,
    });
    this.redis.defineCommand("metabufReleaseEmpty", { numberOfKeys: 4, lua: RELEASE_EMPTY_LUA });
    this.redis.defineCommand("metabufAck", { numberOfKeys: 4, lua: ACK_LUA });
    this.redis.defineCommand("metabufRequeue", { numberOfKeys: 3, lua: REQUEUE_LUA });
  }

  private opsKey(runId: string): string {
    return `${this.prefix}:ops:${runId}`;
  }

  private get dirtyKey(): string {
    return `${this.prefix}:dirty`;
  }

  private lockKey(runId: string): string {
    return `${this.prefix}:lock:${runId}`;
  }

  private pendingKey(runId: string): string {
    return `${this.prefix}:pending:${runId}`;
  }

  private ingestKey(ingestId: string): string {
    return `${this.prefix}:ingest:${ingestId}`;
  }

  isAvailable(): boolean {
    return this.redis.status === "ready";
  }

  async ingest(
    runId: string,
    operations: BufferedRunMetadataChangeOperation[],
    options?: MetadataIngestOptions
  ): Promise<void> {
    if (operations.length === 0) return;
    const serialized = operations.map((op) => JSON.stringify({ t: op.timestamp, o: op.operation }));
    const result = await this.redis.metabufIngest(
      this.opsKey(runId),
      this.dirtyKey,
      this.ingestKey(options?.ingestId ?? randomUUID()),
      runId,
      String(this.now() + this.flushDelayMs),
      String(INGEST_DEDUPE_TTL_MS),
      String(options?.enforceCap === false ? 0 : this.maxPendingOperationsPerRun),
      ...serialized
    );
    if (result === -1) {
      throw new MetadataBufferFullError(runId, this.maxPendingOperationsPerRun);
    }
  }

  async claimDue(
    batchSize: number,
    options?: { includeNotYetDue?: boolean }
  ): Promise<MetadataBufferClaim[]> {
    const now = this.now();
    const candidates = await this.redis.zrangebyscore(
      this.dirtyKey,
      "-inf",
      options?.includeNotYetDue ? "+inf" : String(now),
      "LIMIT",
      0,
      batchSize
    );

    const claims: MetadataBufferClaim[] = [];
    for (const runId of candidates) {
      const token = randomUUID();
      const raw = await this.redis.metabufClaim(
        this.opsKey(runId),
        this.lockKey(runId),
        this.dirtyKey,
        this.pendingKey(runId),
        token,
        String(this.lockTtlMs),
        runId,
        String(now + this.lockTtlMs)
      );

      if (raw === null) continue;

      const [pending, ...items] = raw;

      if (items.length === 0) {
        await this.redis.metabufReleaseEmpty(
          this.lockKey(runId),
          this.dirtyKey,
          this.pendingKey(runId),
          this.opsKey(runId),
          token,
          runId,
          String(now)
        );
        continue;
      }

      const operations = items.map((item) => {
        const parsed = JSON.parse(item) as StoredOp;
        return { runId, timestamp: parsed.t, operation: parsed.o };
      });

      this.active.set(runId, { token, count: operations.length });
      claims.push({ runId, operations, pendingWrite: parsePendingWrite(pending) });
    }

    return claims;
  }

  async recordPendingWrite(claim: MetadataBufferClaim, metadataVersion: number): Promise<boolean> {
    const meta = this.active.get(claim.runId);
    if (!meta) return false;
    const recorded = await this.redis.metabufRecordPending(
      this.lockKey(claim.runId),
      this.pendingKey(claim.runId),
      meta.token,
      `${metadataVersion}:${meta.count}`
    );
    return recorded === 1;
  }

  async ack(claim: MetadataBufferClaim, options?: { count?: number }): Promise<void> {
    const meta = this.active.get(claim.runId);
    if (!meta) return;
    try {
      await this.redis.metabufAck(
        this.opsKey(claim.runId),
        this.lockKey(claim.runId),
        this.dirtyKey,
        this.pendingKey(claim.runId),
        String(options?.count ?? meta.count),
        meta.token,
        claim.runId,
        String(this.now() + this.flushDelayMs)
      );
    } finally {
      this.active.delete(claim.runId);
    }
  }

  async requeue(
    claim: MetadataBufferClaim,
    options?: { keepPendingWrite?: boolean }
  ): Promise<void> {
    const meta = this.active.get(claim.runId);
    if (!meta) return;
    try {
      await this.redis.metabufRequeue(
        this.lockKey(claim.runId),
        this.dirtyKey,
        this.pendingKey(claim.runId),
        meta.token,
        claim.runId,
        String(this.now() + this.requeueBackoffMs),
        options?.keepPendingWrite ? "1" : "0"
      );
    } finally {
      this.active.delete(claim.runId);
    }
  }

  abandon(claim: MetadataBufferClaim): void {
    this.active.delete(claim.runId);
  }

  async size(): Promise<number> {
    return this.redis.zcard(this.dirtyKey);
  }
}

function parsePendingWrite(value: string | undefined): PendingMetadataWrite | undefined {
  if (!value) return undefined;
  const [version, count] = value.split(":").map(Number);
  if (!Number.isInteger(version) || !Number.isInteger(count)) return undefined;
  return { metadataVersion: version, count };
}

/**
 * KEYS: ops, dirty, ingest. ARGV: runId, dueAt, ingestTtlMs, maxPending (0 = no cap), ...ops.
 * The ingest key makes a resent command a no-op. Returns -1 without recording the ingest when the
 * run would exceed maxPending. NX keeps the first operation's deadline.
 */
const INGEST_LUA = `
if redis.call('EXISTS', KEYS[3]) == 1 then
  return 0
end
local maxPending = tonumber(ARGV[4])
if maxPending > 0 and redis.call('LLEN', KEYS[1]) + (#ARGV - 4) > maxPending then
  return -1
end
redis.call('SET', KEYS[3], '1', 'PX', ARGV[3])
for i = 5, #ARGV do
  redis.call('RPUSH', KEYS[1], ARGV[i])
end
redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[1])
return 1
`;

/**
 * KEYS: ops, lock, dirty, pending. ARGV: token, lockTtlMs, runId, reclaimAt.
 * Takes the lock, pushes the run's due time past the lock expiry, and returns the pending write
 * (or an empty string) followed by the operations, without removing them. Returns nil when another
 * process holds the lock.
 */
const CLAIM_LUA = `
if redis.call('SET', KEYS[2], ARGV[1], 'NX', 'PX', ARGV[2]) then
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
  local result = redis.call('LRANGE', KEYS[1], 0, -1)
  table.insert(result, 1, redis.call('GET', KEYS[4]) or '')
  return result
else
  return false
end
`;

/** KEYS: lock, pending. ARGV: token, value. Returns 0 when the lock is no longer held. */
const RECORD_PENDING_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return 0
end
redis.call('SET', KEYS[2], ARGV[2])
return 1
`;

/**
 * KEYS: lock, dirty, pending, ops. ARGV: token, runId, dueAt.
 * Unschedules the run only if its list is still empty; operations that arrived since the claim keep it due.
 */
const RELEASE_EMPTY_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  redis.call('DEL', KEYS[1])
  redis.call('DEL', KEYS[3])
end
if redis.call('LLEN', KEYS[4]) == 0 then
  redis.call('ZREM', KEYS[2], ARGV[2])
else
  redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
end
return 1
`;

/**
 * KEYS: ops, lock, dirty, pending. ARGV: count, token, runId, nextDueAt.
 * Trims the first `count` operations (later ones arrived during the write and stay), clears the
 * pending write, then removes the run from the schedule or reschedules what is left. Returns -1 if
 * the lock was lost.
 */
const ACK_LUA = `
if redis.call('GET', KEYS[2]) ~= ARGV[2] then
  return -1
end
redis.call('LTRIM', KEYS[1], tonumber(ARGV[1]), -1)
redis.call('DEL', KEYS[4])
local remaining = redis.call('LLEN', KEYS[1])
if remaining == 0 then
  redis.call('DEL', KEYS[1])
  redis.call('ZREM', KEYS[3], ARGV[3])
else
  redis.call('ZADD', KEYS[3], ARGV[4], ARGV[3])
end
redis.call('DEL', KEYS[2])
return remaining
`;

/**
 * KEYS: lock, dirty, pending. ARGV: token, runId, dueAt, keepPending ("1" keeps it).
 * Returns -1 without touching the schedule when the lock is held by someone else.
 */
const REQUEUE_LUA = `
if redis.call('GET', KEYS[1]) ~= ARGV[1] then
  return -1
end
redis.call('ZADD', KEYS[2], ARGV[3], ARGV[2])
if ARGV[4] ~= '1' then
  redis.call('DEL', KEYS[3])
end
redis.call('DEL', KEYS[1])
return 1
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    metabufIngest(
      opsKey: string,
      dirtyKey: string,
      ingestKey: string,
      runId: string,
      dueAt: string,
      ingestTtlMs: string,
      maxPending: string,
      ...ops: string[]
    ): Result<number, Context>;
    metabufClaim(
      opsKey: string,
      lockKey: string,
      dirtyKey: string,
      pendingKey: string,
      token: string,
      lockTtlMs: string,
      runId: string,
      reclaimAt: string
    ): Result<string[] | null, Context>;
    metabufRecordPending(
      lockKey: string,
      pendingKey: string,
      token: string,
      value: string
    ): Result<number, Context>;
    metabufReleaseEmpty(
      lockKey: string,
      dirtyKey: string,
      pendingKey: string,
      opsKey: string,
      token: string,
      runId: string,
      dueAt: string
    ): Result<number, Context>;
    metabufAck(
      opsKey: string,
      lockKey: string,
      dirtyKey: string,
      pendingKey: string,
      count: string,
      token: string,
      runId: string,
      nextDueAt: string
    ): Result<number, Context>;
    metabufRequeue(
      lockKey: string,
      dirtyKey: string,
      pendingKey: string,
      token: string,
      runId: string,
      dueAt: string,
      keepPending: string
    ): Result<number, Context>;
  }
}
