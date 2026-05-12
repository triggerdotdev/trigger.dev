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

  async accept(input: {
    runId: string;
    envId: string;
    orgId: string;
    payload: string;
  }): Promise<void> {
    const entryKey = `mollifier:entries:${input.runId}`;
    const queueKey = `mollifier:queue:${input.envId}`;
    const envsKey = "mollifier:envs";
    const createdAt = new Date().toISOString();
    await this.redis.acceptMollifierEntry(
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
  }

  async pop(envId: string): Promise<BufferEntry | null> {
    const queueKey = `mollifier:queue:${envId}`;
    const entryPrefix = "mollifier:entries:";
    const encoded = (await this.redis.popAndMarkDraining(queueKey, entryPrefix)) as
      | string
      | null;
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
      "mollifier:queue:",
      runId,
    );
  }

  async fail(runId: string, error: { code: string; message: string }): Promise<void> {
    await this.redis.hset(`mollifier:entries:${runId}`, {
      status: "FAILED",
      lastError: JSON.stringify(error),
    });
  }

  async getEntryTtlSeconds(runId: string): Promise<number> {
    return this.redis.ttl(`mollifier:entries:${runId}`);
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
      numberOfKeys: 1,
      lua: `
        local entryKey = KEYS[1]
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
        return 1
      `,
    });

    this.redis.defineCommand("popAndMarkDraining", {
      numberOfKeys: 1,
      lua: `
        local queueKey = KEYS[1]
        local entryPrefix = ARGV[1]
        local runId = redis.call('RPOP', queueKey)
        if not runId then
          return nil
        end
        local entryKey = entryPrefix .. runId
        redis.call('HSET', entryKey, 'status', 'DRAINING')
        local raw = redis.call('HGETALL', entryKey)
        local result = {}
        for i = 1, #raw, 2 do
          result[raw[i]] = raw[i + 1]
        end
        return cjson.encode(result)
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
      entryPrefix: string,
      callback?: Callback<string | null>,
    ): Result<string | null, Context>;
    requeueMollifierEntry(
      entryKey: string,
      queuePrefix: string,
      runId: string,
      callback?: Callback<number>,
    ): Result<number, Context>;
  }
}
