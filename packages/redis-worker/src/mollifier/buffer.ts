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

  // Returns true if the entry was newly written; false if a duplicate runId
  // was already buffered (idempotent no-op). Callers can use the boolean to
  // record a duplicate-accept metric without affecting buffer state.
  async accept(input: {
    runId: string;
    envId: string;
    orgId: string;
    payload: string;
  }): Promise<boolean> {
    const entryKey = `mollifier:entries:${input.runId}`;
    const queueKey = `mollifier:queue:${input.envId}`;
    const orgsKey = "mollifier:orgs";
    const createdAt = new Date().toISOString();
    const result = await this.redis.acceptMollifierEntry(
      entryKey,
      queueKey,
      orgsKey,
      input.runId,
      input.envId,
      input.orgId,
      input.payload,
      createdAt,
      String(this.entryTtlSeconds),
      "mollifier:org-envs:",
    );
    return result === 1;
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
  // the dashboard's "Recently queued" surface — LRANGE is non-destructive,
  // so the drainer still pops these entries in order. Returns up to
  // `maxCount` entries (the most-recently-queued ones, since accept LPUSHes
  // onto the head). Each entry hash is fetched separately; a `null` from
  // getEntry (TTL expired between LRANGE and HGETALL) is skipped.
  async listEntriesForEnv(envId: string, maxCount: number): Promise<BufferEntry[]> {
    if (maxCount <= 0) return [];
    const runIds = await this.redis.lrange(`mollifier:queue:${envId}`, 0, maxCount - 1);
    const entries: BufferEntry[] = [];
    for (const runId of runIds) {
      const entry = await this.getEntry(runId);
      if (entry) entries.push(entry);
    }
    return entries;
  }

  async ack(runId: string): Promise<void> {
    await this.redis.del(`mollifier:entries:${runId}`);
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
        local ttlSeconds = tonumber(ARGV[6])
        local orgEnvsPrefix = ARGV[7]

        -- Idempotent: refuse if an entry for this runId already exists in any
        -- state. Caller-side dedup is also enforced via API idempotency keys,
        -- but the buffer must not double-enqueue if a caller retries.
        if redis.call('EXISTS', entryKey) == 1 then
          return 0
        end

        redis.call('HSET', entryKey,
          'runId', runId,
          'envId', envId,
          'orgId', orgId,
          'payload', payload,
          'status', 'QUEUED',
          'attempts', '0',
          'createdAt', createdAt)
        redis.call('EXPIRE', entryKey, ttlSeconds)
        redis.call('LPUSH', queueKey, runId)
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
        if not envId then
          return 0
        end

        local currentAttempts = redis.call('HGET', entryKey, 'attempts')
        local nextAttempts = tonumber(currentAttempts or '0') + 1

        redis.call('HSET', entryKey, 'status', 'QUEUED', 'attempts', tostring(nextAttempts))
        redis.call('LPUSH', queuePrefix .. envId, runId)
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
          local runId = redis.call('RPOP', queueKey)
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
            -- Atomic with the RPOP above — a concurrent accept AFTER this
            -- script will SADD both back along with its LPUSH.
            if redis.call('LLEN', queueKey) == 0 then
              pruneOrgMembership(result['orgId'])
            end
            return cjson.encode(result)
          end
          -- Orphan queue reference: entry TTL expired while runId was queued.
          -- Discard the reference and loop to the next.
        end
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
      ttlSeconds: string,
      orgEnvsPrefix: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
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
