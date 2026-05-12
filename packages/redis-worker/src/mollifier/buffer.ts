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
    const envsKey = "mollifier:envs";
    const createdAt = new Date().toISOString();
    const result = await this.redis.acceptMollifierEntry(
      entryKey,
      queueKey,
      envsKey,
      input.runId,
      input.envId,
      input.orgId,
      input.payload,
      createdAt,
      String(this.entryTtlSeconds),
    );
    return result === 1;
  }

  async pop(envId: string): Promise<BufferEntry | null> {
    const queueKey = `mollifier:queue:${envId}`;
    const envsKey = "mollifier:envs";
    const entryPrefix = "mollifier:entries:";
    const encoded = (await this.redis.popAndMarkDraining(
      queueKey,
      envsKey,
      entryPrefix,
      envId,
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

  async listEnvs(): Promise<string[]> {
    return this.redis.smembers("mollifier:envs");
  }

  async ack(runId: string): Promise<void> {
    await this.redis.del(`mollifier:entries:${runId}`);
  }

  async requeue(runId: string): Promise<void> {
    await this.redis.requeueMollifierEntry(
      `mollifier:entries:${runId}`,
      "mollifier:envs",
      "mollifier:queue:",
      runId,
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
        local envsKey = KEYS[3]
        local runId = ARGV[1]
        local envId = ARGV[2]
        local orgId = ARGV[3]
        local payload = ARGV[4]
        local createdAt = ARGV[5]
        local ttlSeconds = tonumber(ARGV[6])

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
        redis.call('SADD', envsKey, envId)
        return 1
      `,
    });

    this.redis.defineCommand("requeueMollifierEntry", {
      numberOfKeys: 2,
      lua: `
        local entryKey = KEYS[1]
        local envsKey = KEYS[2]
        local queuePrefix = ARGV[1]
        local runId = ARGV[2]

        local envId = redis.call('HGET', entryKey, 'envId')
        if not envId then
          return 0
        end

        local currentAttempts = redis.call('HGET', entryKey, 'attempts')
        local nextAttempts = tonumber(currentAttempts or '0') + 1

        redis.call('HSET', entryKey, 'status', 'QUEUED', 'attempts', tostring(nextAttempts))
        redis.call('LPUSH', queuePrefix .. envId, runId)
        -- Re-track the env: pop may have SREM'd it when the queue last
        -- emptied. SADD is idempotent if the env is still present.
        redis.call('SADD', envsKey, envId)
        return 1
      `,
    });

    this.redis.defineCommand("popAndMarkDraining", {
      numberOfKeys: 2,
      lua: `
        local queueKey = KEYS[1]
        local envsKey = KEYS[2]
        local entryPrefix = ARGV[1]
        local envId = ARGV[2]

        -- Loop to skip orphan queue references — runIds whose entry hash has
        -- expired (TTL hit). HSET on a missing key would CREATE a partial
        -- hash without a TTL, leaking memory. The loop is bounded by queue
        -- length; entire Lua script remains atomic.
        while true do
          local runId = redis.call('RPOP', queueKey)
          if not runId then
            -- Queue is empty; opportunistically prune envs set. SREM is safe
            -- under concurrent LPUSH: accept SADDs the env back atomically.
            if redis.call('LLEN', queueKey) == 0 then
              redis.call('SREM', envsKey, envId)
            end
            return nil
          end

          local entryKey = entryPrefix .. runId
          if redis.call('EXISTS', entryKey) == 1 then
            redis.call('HSET', entryKey, 'status', 'DRAINING')
            -- Prune envs set if this pop drained the queue. Atomic with the
            -- RPOP above — a concurrent accept AFTER this script will SADD
            -- the env back along with its LPUSH.
            if redis.call('LLEN', queueKey) == 0 then
              redis.call('SREM', envsKey, envId)
            end
            local raw = redis.call('HGETALL', entryKey)
            local result = {}
            for i = 1, #raw, 2 do
              result[raw[i]] = raw[i + 1]
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
      envsKey: string,
      runId: string,
      envId: string,
      orgId: string,
      payload: string,
      createdAt: string,
      ttlSeconds: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
    popAndMarkDraining(
      queueKey: string,
      envsKey: string,
      entryPrefix: string,
      envId: string,
      callback?: Callback<string | null>,
    ): Result<string | null, Context>;
    requeueMollifierEntry(
      entryKey: string,
      envsKey: string,
      queuePrefix: string,
      runId: string,
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
