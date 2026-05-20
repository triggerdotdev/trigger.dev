import {
  createRedisClient,
  type Callback,
  type Redis,
  type RedisOptions,
  type Result,
} from "@internal/redis";
import { Logger } from "@trigger.dev/core/logger";
import { BufferEntry, BufferEntrySchema } from "./schemas.js";

export type MollifierBufferOptions = {
  redisOptions: RedisOptions;
  entryTtlSeconds: number;
  logger?: Logger;
};

// Grace TTL applied to the entry hash on drainer ack. The entry survives
// this long after materialisation so direct reads (retrieve, trace, etc.)
// have a safety net while PG replica lag settles. Q1 D2.
const ACK_GRACE_TTL_SECONDS = 30;

export type SnapshotPatch =
  | { type: "append_tags"; tags: string[] }
  | { type: "set_metadata"; metadata: string; metadataType: string }
  | { type: "set_delay"; delayUntil: string }
  | { type: "mark_cancelled"; cancelledAt: string; cancelReason?: string };

export type MutateSnapshotResult = "applied_to_snapshot" | "not_found" | "busy";

export type AcceptResult =
  | { kind: "accepted" }
  | { kind: "duplicate_run_id" }
  | { kind: "duplicate_idempotency"; existingRunId: string };

export type IdempotencyLookupInput = {
  envId: string;
  taskIdentifier: string;
  idempotencyKey: string;
};

function makeIdempotencyLookupKey(input: IdempotencyLookupInput): string {
  return `mollifier:idempotency:${input.envId}:${input.taskIdentifier}:${input.idempotencyKey}`;
}

export class MollifierBuffer {
  private readonly redis: Redis;
  private readonly entryTtlSeconds: number;
  private readonly logger: Logger;

  constructor(options: MollifierBufferOptions) {
    this.entryTtlSeconds = options.entryTtlSeconds;
    this.logger = options.logger ?? new Logger("MollifierBuffer", "debug");

    this.redis = createRedisClient(
      {
        ...options.redisOptions,
        retryStrategy(times) {
          const delay = Math.min(times * 50, 1000);
          return delay;
        },
        maxRetriesPerRequest: 20,
      },
      {
        onError: (error) => {
          this.logger.error("MollifierBuffer redis client error:", { error });
        },
      },
    );
    this.#registerCommands();
  }

  // Three outcomes:
  //   - { kind: "accepted" } — entry was newly written.
  //   - { kind: "duplicate_run_id" } — runId was already buffered (idempotent
  //     no-op, same semantic as the previous boolean-false return).
  //   - { kind: "duplicate_idempotency", existingRunId } — the (env, task,
  //     idempotencyKey) tuple was already bound to another buffered run.
  //     The Lua's atomic SETNX is the race-winner; the second caller gets
  //     the winner's runId so it can return that as the trigger response.
  async accept(input: {
    runId: string;
    envId: string;
    orgId: string;
    payload: string;
    // Optional idempotency-key triple. When all three are present we
    // SETNX a Redis lookup at `mollifier:idempotency:{env}:{task}:{key}`
    // pointing at the runId so trigger-time dedup during the buffered
    // window resolves the same way PG's unique constraint resolves it
    // post-materialisation (Q5).
    idempotencyKey?: string;
    taskIdentifier?: string;
  }): Promise<AcceptResult> {
    const entryKey = `mollifier:entries:${input.runId}`;
    const queueKey = `mollifier:queue:${input.envId}`;
    const orgsKey = "mollifier:orgs";
    const nowMs = Date.now();
    const createdAt = new Date(nowMs).toISOString();
    // Microsecond epoch. JS only has millisecond precision, so multiple
    // accepts in the same ms share a score; ZSET ties resolve by member
    // (runId) lex order, which is deterministic and acceptable for FIFO
    // pop. The hash carries the same value as `createdAtMicros` so the
    // listing helper (Phase E) can read a stable per-run timestamp
    // without re-fetching the score.
    const createdAtMicros = nowMs * 1000;
    const idempotencyLookupKey =
      input.idempotencyKey && input.taskIdentifier
        ? makeIdempotencyLookupKey({
            envId: input.envId,
            taskIdentifier: input.taskIdentifier,
            idempotencyKey: input.idempotencyKey,
          })
        : "";
    const result = await this.redis.acceptMollifierEntry(
      entryKey,
      queueKey,
      orgsKey,
      input.runId,
      input.envId,
      input.orgId,
      input.payload,
      createdAt,
      String(createdAtMicros),
      String(this.entryTtlSeconds),
      "mollifier:org-envs:",
      idempotencyLookupKey,
    );
    // Lua returns 1 (accepted), 0 (duplicate runId), or a string runId
    // (duplicate idempotency — value is the existing winner's runId).
    if (typeof result === "string" && result.length > 0) {
      return { kind: "duplicate_idempotency", existingRunId: result };
    }
    if (result === 1) return { kind: "accepted" };
    return { kind: "duplicate_run_id" };
  }

  async pop(envId: string): Promise<BufferEntry | null> {
    const queueKey = `mollifier:queue:${envId}`;
    const orgsKey = "mollifier:orgs";
    const entryPrefix = "mollifier:entries:";
    const encoded = (await this.redis.popAndMarkDraining(
      queueKey,
      orgsKey,
      entryPrefix,
      envId,
      "mollifier:org-envs:",
    )) as string | null;
    if (!encoded) return null;

    let raw: unknown;
    try {
      raw = JSON.parse(encoded);
    } catch {
      this.logger.error("MollifierBuffer.pop: failed to parse script result", { envId });
      return null;
    }

    const parsed = BufferEntrySchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error("MollifierBuffer.pop: invalid entry shape", {
        envId,
        errors: parsed.error.flatten(),
      });
      return null;
    }
    return parsed.data;
  }

  async getEntry(runId: string): Promise<BufferEntry | null> {
    const raw = await this.redis.hgetall(`mollifier:entries:${runId}`);
    if (!raw || Object.keys(raw).length === 0) return null;

    const parsed = BufferEntrySchema.safeParse(raw);
    if (!parsed.success) {
      this.logger.error("MollifierBuffer.getEntry: invalid entry shape", {
        runId,
        errors: parsed.error.flatten(),
      });
      return null;
    }
    return parsed.data;
  }

  // Drainer walks these two methods to schedule pops with org-level
  // fairness: one env per org per tick. The Lua scripts maintain both
  // sets atomically with the per-env queues, so an org/env appears here
  // exactly when at least one of its envs has a queued entry.
  async listOrgs(): Promise<string[]> {
    return this.redis.smembers("mollifier:orgs");
  }

  async listEnvsForOrg(orgId: string): Promise<string[]> {
    return this.redis.smembers(`mollifier:org-envs:${orgId}`);
  }

  // Read-only listing of currently-queued entries for a single env. Used by
  // the dashboard's "Recently queued" surface — non-destructive, so the
  // drainer still pops these entries in order. Returns up to `maxCount`
  // entries newest-first (highest score, which is `createdAtMicros`).
  // Each entry hash is fetched separately; a `null` from getEntry (TTL
  // expired between ZREVRANGE and HGETALL) is skipped.
  async listEntriesForEnv(envId: string, maxCount: number): Promise<BufferEntry[]> {
    if (maxCount <= 0) return [];
    const runIds = await this.redis.zrevrange(
      `mollifier:queue:${envId}`,
      0,
      maxCount - 1,
    );
    const entries: BufferEntry[] = [];
    for (const runId of runIds) {
      const entry = await this.getEntry(runId);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  // Atomic snapshot mutation. Used by customer-mutation API endpoints
  // (tags, metadata-put, reschedule, cancel) when the run is still in
  // the buffer. Three outcomes:
  //   - "applied_to_snapshot": entry was QUEUED + not materialised; the
  //     drainer will read the patched payload on its next pop.
  //   - "not_found": no entry hash exists for this runId.
  //   - "busy": entry is DRAINING / FAILED / materialised. The API
  //     wait-and-bounces through PG (Q3 design).
  async mutateSnapshot(runId: string, patch: SnapshotPatch): Promise<MutateSnapshotResult> {
    const result = (await this.redis.mutateMollifierSnapshot(
      `mollifier:entries:${runId}`,
      JSON.stringify(patch),
    )) as string;
    if (
      result === "applied_to_snapshot" ||
      result === "not_found" ||
      result === "busy"
    ) {
      return result;
    }
    throw new Error(`MollifierBuffer.mutateSnapshot: unexpected Lua return value: ${result}`);
  }

  // Resolve a buffered run by (env, task, idempotencyKey) tuple. Used by
  // `IdempotencyKeyConcern.handleTriggerRequest` after the PG check
  // misses — same key may belong to a buffered run waiting to drain. The
  // lookup self-heals: if the lookup points at an entry hash that's
  // expired, we DEL the lookup and report a miss.
  async lookupIdempotency(input: IdempotencyLookupInput): Promise<string | null> {
    const lookupKey = makeIdempotencyLookupKey(input);
    const runId = await this.redis.get(lookupKey);
    if (!runId) return null;
    const entry = await this.getEntry(runId);
    if (!entry) {
      await this.redis.del(lookupKey);
      return null;
    }
    return runId;
  }

  // Clear the idempotency binding from a buffered run. Used by
  // `ResetIdempotencyKeyService` alongside the existing PG-side
  // `updateMany`. Returns the runId that was cleared, or null if no
  // buffered run held this key.
  async resetIdempotency(input: IdempotencyLookupInput): Promise<{ clearedRunId: string | null }> {
    const lookupKey = makeIdempotencyLookupKey(input);
    const clearedRunId = (await this.redis.resetMollifierIdempotency(
      lookupKey,
      "mollifier:entries:",
    )) as string;
    return { clearedRunId: clearedRunId.length > 0 ? clearedRunId : null };
  }

  // Marks the entry as materialised (PG row written) and resets its TTL to
  // the grace window. Entry hash persists past ack as a read-fallback
  // safety net for the brief PG replica-lag window between drainer-side
  // write and reader-side visibility (Q1 D2). Also clears the associated
  // idempotency lookup if one was set on accept (Q5).
  async ack(runId: string): Promise<void> {
    await this.redis.ackMollifierEntry(
      `mollifier:entries:${runId}`,
      String(ACK_GRACE_TTL_SECONDS),
    );
  }

  async requeue(runId: string): Promise<void> {
    await this.redis.requeueMollifierEntry(
      `mollifier:entries:${runId}`,
      "mollifier:orgs",
      "mollifier:queue:",
      runId,
      "mollifier:org-envs:",
    );
  }

  // Returns true if the entry transitioned to FAILED; false if the entry no
  // longer exists (TTL expired between pop and fail). Caller can use the
  // boolean to skip downstream FAILED handling for ghost entries.
  async fail(runId: string, error: { code: string; message: string }): Promise<boolean> {
    const result = await this.redis.failMollifierEntry(
      `mollifier:entries:${runId}`,
      JSON.stringify(error),
    );
    return result === 1;
  }

  async getEntryTtlSeconds(runId: string): Promise<number> {
    return this.redis.ttl(`mollifier:entries:${runId}`);
  }

  async evaluateTrip(
    envId: string,
    options: { windowMs: number; threshold: number; holdMs: number },
  ): Promise<{ tripped: boolean; count: number }> {
    const rateKey = `mollifier:rate:${envId}`;
    const trippedKey = `mollifier:tripped:${envId}`;
    const result = (await this.redis.mollifierEvaluateTrip(
      rateKey,
      trippedKey,
      String(options.windowMs),
      String(options.threshold),
      String(options.holdMs),
    )) as [number, number];

    return { count: result[0], tripped: result[1] === 1 };
  }

  async close(): Promise<void> {
    await this.redis.quit();
  }

  #registerCommands() {
    this.redis.defineCommand("acceptMollifierEntry", {
      numberOfKeys: 3,
      lua: `
        local entryKey = KEYS[1]
        local queueKey = KEYS[2]
        local orgsKey = KEYS[3]
        local runId = ARGV[1]
        local envId = ARGV[2]
        local orgId = ARGV[3]
        local payload = ARGV[4]
        local createdAt = ARGV[5]
        local createdAtMicros = ARGV[6]
        local ttlSeconds = tonumber(ARGV[7])
        local orgEnvsPrefix = ARGV[8]
        local idempotencyLookupKey = ARGV[9] or ''

        -- Idempotent: refuse if an entry for this runId already exists in any
        -- state. Caller-side dedup is also enforced via API idempotency keys,
        -- but the buffer must not double-enqueue if a caller retries.
        if redis.call('EXISTS', entryKey) == 1 then
          return 0
        end

        -- Idempotency-key dedup (Q5). If the caller passed a lookup key
        -- and it's already bound to another buffered run, return the
        -- winner's runId so the loser's API response can echo it as a
        -- cached hit. Otherwise SET the lookup with the same TTL as the
        -- entry hash; the drainer ack clears it explicitly.
        if idempotencyLookupKey ~= '' then
          local existing = redis.call('GET', idempotencyLookupKey)
          if existing then
            return existing
          end
          redis.call('SET', idempotencyLookupKey, runId, 'EX', ttlSeconds)
        end

        redis.call('HSET', entryKey,
          'runId', runId,
          'envId', envId,
          'orgId', orgId,
          'payload', payload,
          'status', 'QUEUED',
          'attempts', '0',
          'createdAt', createdAt,
          'createdAtMicros', createdAtMicros,
          'idempotencyLookupKey', idempotencyLookupKey)
        redis.call('EXPIRE', entryKey, ttlSeconds)
        -- ZSET keyed by createdAtMicros: ZPOPMIN drains oldest-first
        -- (FIFO); listing pagination uses ZREVRANGEBYSCORE with a
        -- (createdAt, runId) cursor anchor. Score is stable across the
        -- entry's lifecycle — requeue does not bump it (see Phase 3b /
        -- Q1 design).
        redis.call('ZADD', queueKey, createdAtMicros, runId)
        -- Org-level membership: maintained atomically with the per-env
        -- queue so the drainer can walk orgs → envs-for-org and
        -- schedule one env per org per tick. SADDs are idempotent if the
        -- org/env are already tracked.
        redis.call('SADD', orgsKey, orgId)
        redis.call('SADD', orgEnvsPrefix .. orgId, envId)
        return 1
      `,
    });

    this.redis.defineCommand("requeueMollifierEntry", {
      numberOfKeys: 2,
      lua: `
        local entryKey = KEYS[1]
        local orgsKey = KEYS[2]
        local queuePrefix = ARGV[1]
        local runId = ARGV[2]
        local orgEnvsPrefix = ARGV[3]

        local envId = redis.call('HGET', entryKey, 'envId')
        local orgId = redis.call('HGET', entryKey, 'orgId')
        local createdAtMicros = redis.call('HGET', entryKey, 'createdAtMicros')
        if not envId or not createdAtMicros then
          return 0
        end

        local currentAttempts = redis.call('HGET', entryKey, 'attempts')
        local nextAttempts = tonumber(currentAttempts or '0') + 1

        redis.call('HSET', entryKey, 'status', 'QUEUED', 'attempts', tostring(nextAttempts))
        -- Requeue re-adds with the ORIGINAL createdAtMicros score.
        -- createdAt is immutable across retries (Phase 3b decision).
        -- The drainer's maxAttempts caps the retry loop so a poisoned
        -- entry doesn't head-of-line forever.
        redis.call('ZADD', queuePrefix .. envId, tonumber(createdAtMicros), runId)
        -- Re-track the org/env: pop may have SREM'd them when the queue
        -- last emptied. SADDs are idempotent if the values are still
        -- present.
        if orgId then
          redis.call('SADD', orgsKey, orgId)
          redis.call('SADD', orgEnvsPrefix .. orgId, envId)
        end
        return 1
      `,
    });

    this.redis.defineCommand("popAndMarkDraining", {
      numberOfKeys: 2,
      lua: `
        local queueKey = KEYS[1]
        local orgsKey = KEYS[2]
        local entryPrefix = ARGV[1]
        local envId = ARGV[2]
        local orgEnvsPrefix = ARGV[3]

        -- Helper: prune org-level membership when an env's queue empties.
        -- Called only from the success branch where we know orgId from the
        -- popped entry. The no-runId branch below can't reach this because
        -- it has no entry to read orgId from — accept any stale org-envs
        -- entries that result (bounded by env count, recovered next accept).
        local function pruneOrgMembership(orgId)
          if not orgId then return end
          local orgEnvsKey = orgEnvsPrefix .. orgId
          redis.call('SREM', orgEnvsKey, envId)
          if redis.call('SCARD', orgEnvsKey) == 0 then
            redis.call('SREM', orgsKey, orgId)
          end
        end

        -- Loop to skip orphan queue references — runIds whose entry hash has
        -- expired (TTL hit). HSET on a missing key would CREATE a partial
        -- hash without a TTL, leaking memory. The loop is bounded by queue
        -- length; entire Lua script remains atomic.
        while true do
          -- ZPOPMIN returns {member, score} as a flat array, or {} when empty.
          local popped = redis.call('ZPOPMIN', queueKey)
          local runId = popped[1]
          if not runId then
            -- Queue is empty AND we have no entry to read orgId from, so
            -- skip org-level cleanup. Stale org-envs entries are bounded
            -- by env count and recovered on the next accept.
            return nil
          end

          local entryKey = entryPrefix .. runId
          if redis.call('EXISTS', entryKey) == 1 then
            redis.call('HSET', entryKey, 'status', 'DRAINING')
            local raw = redis.call('HGETALL', entryKey)
            local result = {}
            for i = 1, #raw, 2 do
              result[raw[i]] = raw[i + 1]
            end
            -- Prune org-level membership if this pop drained the queue.
            -- Atomic with the ZPOPMIN above — a concurrent accept AFTER
            -- this script will SADD both back along with its ZADD.
            if redis.call('ZCARD', queueKey) == 0 then
              pruneOrgMembership(result['orgId'])
            end
            return cjson.encode(result)
          end
          -- Orphan queue reference: entry TTL expired while runId was queued.
          -- Discard the reference and loop to the next.
        end
      `,
    });

    this.redis.defineCommand("resetMollifierIdempotency", {
      numberOfKeys: 1,
      lua: `
        local lookupKey = KEYS[1]
        local entryPrefix = ARGV[1]

        local runId = redis.call('GET', lookupKey)
        if not runId then
          return ''
        end

        local entryKey = entryPrefix .. runId
        if redis.call('EXISTS', entryKey) == 0 then
          -- Stale lookup. Lazy cleanup.
          redis.call('DEL', lookupKey)
          return ''
        end

        -- Clear the idempotency fields on the snapshot payload so the
        -- drainer's eventual engine.trigger call inserts a PG row
        -- without the key set.
        local payloadJson = redis.call('HGET', entryKey, 'payload')
        if payloadJson then
          local ok, payload = pcall(cjson.decode, payloadJson)
          if ok then
            payload.idempotencyKey = cjson.null
            payload.idempotencyKeyExpiresAt = cjson.null
            redis.call('HSET', entryKey, 'payload', cjson.encode(payload))
          end
        end
        -- Clear the denormalised lookup pointer on the hash so a later
        -- ack doesn't try to DEL a key that's already gone.
        redis.call('HSET', entryKey, 'idempotencyLookupKey', '')
        redis.call('DEL', lookupKey)
        return runId
      `,
    });

    this.redis.defineCommand("mutateMollifierSnapshot", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local patchJson = ARGV[1]

        if redis.call('EXISTS', entryKey) == 0 then
          return 'not_found'
        end

        local status = redis.call('HGET', entryKey, 'status')
        local materialised = redis.call('HGET', entryKey, 'materialised')
        if status ~= 'QUEUED' or materialised == 'true' then
          return 'busy'
        end

        local payloadJson = redis.call('HGET', entryKey, 'payload')
        local ok, payload = pcall(cjson.decode, payloadJson)
        if not ok then return 'busy' end

        local patch = cjson.decode(patchJson)

        if patch.type == 'append_tags' then
          -- cjson decode of an absent or empty-array field gives nil or
          -- an empty table; we rebuild as a dense array. Existing tags
          -- are preserved; new tags are appended only if not present.
          local existing = payload.tags or {}
          local seen = {}
          local merged = {}
          for _, t in ipairs(existing) do
            if not seen[t] then
              seen[t] = true
              table.insert(merged, t)
            end
          end
          for _, t in ipairs(patch.tags or {}) do
            if not seen[t] then
              seen[t] = true
              table.insert(merged, t)
            end
          end
          payload.tags = merged
        elseif patch.type == 'set_metadata' then
          payload.metadata = patch.metadata
          payload.metadataType = patch.metadataType
        elseif patch.type == 'set_delay' then
          payload.delayUntil = patch.delayUntil
        elseif patch.type == 'mark_cancelled' then
          payload.cancelledAt = patch.cancelledAt
          payload.cancelReason = patch.cancelReason
        else
          return 'busy'
        end

        redis.call('HSET', entryKey, 'payload', cjson.encode(payload))
        return 'applied_to_snapshot'
      `,
    });

    this.redis.defineCommand("ackMollifierEntry", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local graceTtlSeconds = tonumber(ARGV[1])

        -- Guard: never create a partial entry. If the hash expired between
        -- pop and ack, the run is gone — nothing to mark materialised.
        if redis.call('EXISTS', entryKey) == 0 then
          return 0
        end

        -- If the entry was accepted with an idempotency key, the lookup
        -- string was stored on the hash at accept time. Clear it now —
        -- PG becomes canonical for the key post-materialisation (Q5).
        local lookupKey = redis.call('HGET', entryKey, 'idempotencyLookupKey')
        if lookupKey and lookupKey ~= '' then
          redis.call('DEL', lookupKey)
        end

        redis.call('HSET', entryKey, 'materialised', 'true')
        redis.call('EXPIRE', entryKey, graceTtlSeconds)
        return 1
      `,
    });

    this.redis.defineCommand("failMollifierEntry", {
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
        local errorPayload = ARGV[1]

        -- Guard: never create a partial entry. If the hash expired between
        -- pop and fail, the run is gone — nothing to mark FAILED.
        if redis.call('EXISTS', entryKey) == 0 then
          return 0
        end

        redis.call('HSET', entryKey, 'status', 'FAILED', 'lastError', errorPayload)
        return 1
      `,
    });

    this.redis.defineCommand("mollifierEvaluateTrip", {
      numberOfKeys: 2,
      lua: `
        local rateKey = KEYS[1]
        local trippedKey = KEYS[2]
        local windowMs = tonumber(ARGV[1])
        local threshold = tonumber(ARGV[2])
        local holdMs = tonumber(ARGV[3])

        local count = redis.call('INCR', rateKey)
        if count == 1 then
          redis.call('PEXPIRE', rateKey, windowMs)
        end

        if count > threshold then
          redis.call('PSETEX', trippedKey, holdMs, '1')
        end

        local tripped = redis.call('EXISTS', trippedKey)
        return {count, tripped}
      `,
    });
  }
}

declare module "@internal/redis" {
  interface RedisCommander<Context> {
    acceptMollifierEntry(
      entryKey: string,
      queueKey: string,
      orgsKey: string,
      runId: string,
      envId: string,
      orgId: string,
      payload: string,
      createdAt: string,
      createdAtMicros: string,
      ttlSeconds: string,
      orgEnvsPrefix: string,
      idempotencyLookupKey: string,
      callback?: Callback<number | string>,
    ): Result<number | string, Context>;
    popAndMarkDraining(
      queueKey: string,
      orgsKey: string,
      entryPrefix: string,
      envId: string,
      orgEnvsPrefix: string,
      callback?: Callback<string | null>,
    ): Result<string | null, Context>;
    requeueMollifierEntry(
      entryKey: string,
      orgsKey: string,
      queuePrefix: string,
      runId: string,
      orgEnvsPrefix: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    mutateMollifierSnapshot(
      entryKey: string,
      patchJson: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    resetMollifierIdempotency(
      lookupKey: string,
      entryPrefix: string,
      callback?: Callback<string>,
    ): Result<string, Context>;
    ackMollifierEntry(
      entryKey: string,
      graceTtlSeconds: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    failMollifierEntry(
      entryKey: string,
      errorPayload: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    mollifierEvaluateTrip(
      rateKey: string,
      trippedKey: string,
      windowMs: string,
      threshold: string,
      holdMs: string,
      callback?: Callback<[number, number]>,
    ): Result<[number, number], Context>;
  }
}
