import { env } from "~/env.server";
import {
  Callback,
  Cluster,
  ClusterNode,
  ClusterOptions,
  Redis,
  RedisOptions,
  Result,
} from "ioredis";
import { JobHelpers, Task } from "graphile-worker";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";
import { ZodWorkerRateLimiter } from "@internal/zod-worker";
import {
  ConcurrencyLimitGroup,
  JobRun,
  JobVersion,
  RuntimeEnvironment,
} from "@trigger.dev/database";

export interface RunExecutionRateLimiter {
  putConcurrencyLimitGroup(
    concurrencyLimitGroup: ConcurrencyLimitGroup,
    env: RuntimeEnvironment
  ): Promise<void>;
  putJobVersionConcurrencyLimit(jobVersion: JobVersion, env: RuntimeEnvironment): Promise<void>;
  setMaxSizeForFlag(flag: string, maxSize: number): Promise<void>;
  delMaxSizeForFlag(flag: string): Promise<void>;
  flagsForRun(
    run: JobRun,
    version: JobVersion & {
      environment: RuntimeEnvironment;
      concurrencyLimitGroup?: ConcurrencyLimitGroup;
    }
  ): string[];
}

declare module "ioredis" {
  interface RedisCommander<Context> {
    beforeTask(
      setKey: string,
      maxSizeKey: string,
      forbiddenFlagsKey: string,
      jobId: string,
      timestamp: string,
      windowSize: string,
      forbiddenFlag: string,
      maxSize: string,
      callback?: Callback<string>
    ): Result<number | null, Context>;
    rollbackBeforeTask(keys: number, ...args: string[]): Result<string, Context>;

    afterTask(
      setKey: string,
      maxSizeKey: string,
      forbiddenFlagsKey: string,
      jobId: string,
      timestamp: string,
      windowSize: string,
      forbiddenFlag: string,
      maxSize: string,
      callback?: Callback<string>
    ): Result<number | null, Context>;
  }
}

type RedisRunExecutionRateLimiterOptions = {
  redis?: RedisOptions;
  cluster?: {
    startupNodes: ClusterNode[];
    options?: ClusterOptions;
  };
  defaultConcurrency?: number;
  windowSize?: number;
  prefix?: string;
};

const FORBIDDEN_FLAG_KEY = "forbiddenFlags";
const PAUSED_FLAG_KEY = "pausedFlags";
const KEY_PREFIX = "tr:exec:";

class RedisRunExecutionRateLimiter implements RunExecutionRateLimiter, ZodWorkerRateLimiter {
  private redis: Redis | Cluster;
  private defaultMaxSize: number;
  private windowSize: number;

  constructor(options?: RedisRunExecutionRateLimiterOptions) {
    this.redis = options?.cluster
      ? new Redis.Cluster(options.cluster.startupNodes, options.cluster.options)
      : new Redis(options?.redis ?? {});
    this.defaultMaxSize = options?.defaultConcurrency ?? 10;
    this.windowSize = options?.windowSize ?? 1000 * 15 * 60; // 2 minutes

    this.redis.defineCommand("beforeTask", {
      numberOfKeys: 3,
      lua: `
local setKey = KEYS[1]
local maxSizeKey = KEYS[2]
local forbiddenFlagsKey = KEYS[3]
local jobId = ARGV[1]
local timestamp = ARGV[2]
local windowSize = ARGV[3]
local forbiddenFlag = ARGV[4]
local defaultMaxSize = ARGV[5]

local maxSize = tonumber(redis.call('GET', maxSizeKey) or defaultMaxSize)
local currentSize = redis.call('ZCOUNT', setKey, timestamp - windowSize, timestamp)

if currentSize < maxSize then
    redis.call('ZADD', setKey, timestamp, jobId)

    if currentSize + 1 >= maxSize then
        redis.call('SADD', forbiddenFlagsKey, forbiddenFlag)
    end

    return true
else
    redis.call('SADD', forbiddenFlagsKey, forbiddenFlag)

    return false
end
      `,
    });

    // This will remove the job ID from the ZSET
    this.redis.defineCommand("rollbackBeforeTask", {
      lua: `
for i, key in ipairs(KEYS) do
  redis.call('ZREM', key, ARGV[1])
end
      `,
    });

    this.redis.defineCommand("afterTask", {
      numberOfKeys: 3,
      lua: `
local setKey = KEYS[1]
local maxSizeKey = KEYS[2]
local forbiddenFlagsKey = KEYS[3]
local jobId = ARGV[1]
local timestamp = ARGV[2]
local windowSize = ARGV[3]
local forbiddenFlag = ARGV[4]
local defaultMaxSize = ARGV[5]

local maxSize = tonumber(redis.call('GET', maxSizeKey) or defaultMaxSize)

-- Remove the job ID from the ZSET
redis.call('ZREM', setKey, jobId)

-- Count the current number of jobs in the window
local currentSize = redis.call('ZCOUNT', setKey, timestamp - windowSize, timestamp)

-- The cleanup of old job IDs is now an essential part of maintaining the ZSET's size
redis.call('ZREMRANGEBYSCORE', setKey, '-inf', timestamp - windowSize)

-- Update the forbidden flags based on the current size
if currentSize < maxSize then
    -- Only remove the forbidden flag if it's no longer needed
    redis.call('SREM', forbiddenFlagsKey, forbiddenFlag)
    return true
else
    -- No need to add the forbidden flag here as it should be handled in beforeTask
    return false
end

      `,
    });

    if (this.redis instanceof Redis) {
      logger.debug("⚡ RedisGraphileRateLimiter connected to Redis", {
        host: this.redis.options.host,
        port: this.redis.options.port,
      });
    } else {
      logger.debug("⚡ RedisGraphileRateLimiter connected to Redis Cluster", {
        nodes: this.redis.nodes,
      });
    }
  }

  async forbiddenFlags(): Promise<string[]> {
    return this.redis.sunion(FORBIDDEN_FLAG_KEY, PAUSED_FLAG_KEY);
  }

  async putConcurrencyLimitGroup(
    concurrencyLimitGroup: ConcurrencyLimitGroup,
    env: RuntimeEnvironment
  ): Promise<void> {
    await this.setMaxSizeForFlag(
      this.flagForConcurrencyLimitGroup(concurrencyLimitGroup, env),
      concurrencyLimitGroup.concurrencyLimit
    );
  }

  async putJobVersionConcurrencyLimit(
    jobVersion: JobVersion,
    env: RuntimeEnvironment
  ): Promise<void> {
    const flag = this.flagForJobVersion(jobVersion, env);

    if (typeof jobVersion.concurrencyLimit === "number" && jobVersion.concurrencyLimit > 0) {
      await this.setMaxSizeForFlag(flag, jobVersion.concurrencyLimit);
    } else {
      await this.delMaxSizeForFlag(flag);
    }
  }

  flagsForRun(
    run: JobRun,
    version: JobVersion & {
      environment: RuntimeEnvironment;
      concurrencyLimitGroup?: ConcurrencyLimitGroup | null;
    }
  ): string[] {
    const flags = [this.flagForOrganization(run)];

    if (version.concurrencyLimitGroup) {
      flags.push(
        this.flagForConcurrencyLimitGroup(version.concurrencyLimitGroup, version.environment)
      );
    } else if (typeof version.concurrencyLimit === "number" && version.concurrencyLimit > 0) {
      flags.push(this.flagForJobVersion(version, version.environment));
    }

    return flags;
  }

  flagForConcurrencyLimitGroup(
    concurrencyLimitGroup: ConcurrencyLimitGroup,
    env: RuntimeEnvironment
  ): string {
    return `rl:group:${env.id}:${env.slug}:${concurrencyLimitGroup.name}`;
  }

  flagForOrganization(run: JobRun): string {
    return `rl:org:${run.organizationId}`;
  }

  flagForJobVersion(version: JobVersion, env: RuntimeEnvironment): string {
    return `rl:job:${env.slug}:${version.id}`;
  }

  async setMaxSizeForFlag(flag: string, maxSize: number): Promise<void> {
    await this.redis.set(`${flag}:maxSize`, String(maxSize));
  }

  async delMaxSizeForFlag(flag: string): Promise<void> {
    await this.redis.del(`${flag}:maxSize`);
  }

  wrapTask(t: Task, rescheduler: Task): Task {
    return async (payload: unknown, helpers: JobHelpers) => {
      const flags = Object.keys(helpers.job.flags ?? {}).filter((flag) => flag.startsWith("rl:"));

      if (flags.length === 0) {
        return t(payload, helpers);
      }

      let passedFlags = [];

      for (const flag of flags) {
        const result = await this.#callBeforeTask(flag, String(helpers.job.id));

        if (
          (result.status === "fulfilled" && result.value === null) ||
          result.status === "rejected"
        ) {
          logger.debug("Rolling back passed flags", {
            flag,
            passedFlags,
            jobId: String(helpers.job.id),
            result,
          });
          // If there are any passed flags, we need to roll them back
          await this.#rollbackPassedFlags(passedFlags, String(helpers.job.id));

          return await rescheduler(payload, helpers);
        }

        passedFlags.push(flag);
      }

      try {
        await t(payload, helpers);
      } finally {
        const afterResults = await Promise.allSettled(
          flags.map(async (flag) => this.#callAfterTask(flag, String(helpers.job.id)))
        );
      }
    };
  }

  async #callBeforeTask(
    flag: string,
    jobId: string
  ): Promise<
    | { status: "fulfilled"; value: number | null; durationInMs: number }
    | { status: "rejected"; error: any }
  > {
    try {
      const now = performance.now();
      const value = await this.redis.beforeTask(
        flag,
        `${flag}:maxSize`,
        FORBIDDEN_FLAG_KEY,
        jobId,
        String(Date.now()),
        String(this.windowSize),
        flag,
        String(this.defaultMaxSize)
      );

      const durationInMs = performance.now() - now;

      return {
        status: "fulfilled",
        value,
        durationInMs,
      };
    } catch (error) {
      logger.error("Failed to call beforeTask", { error, flag, jobId });

      return {
        status: "rejected",
        error,
      };
    }
  }

  // Method for rolling back passed flags using a single Lua script
  async #rollbackPassedFlags(passedFlags: string[], jobId: string) {
    if (passedFlags.length > 0) {
      await this.redis.rollbackBeforeTask(passedFlags.length, ...passedFlags, jobId);
    }
  }

  async #callAfterTask(flag: string, jobId: string) {
    try {
      const now = performance.now();

      const results = await this.redis.afterTask(
        flag,
        `${flag}:maxSize`,
        FORBIDDEN_FLAG_KEY,
        jobId,
        String(Date.now()),
        String(this.windowSize),
        flag,
        String(this.defaultMaxSize)
      );

      const durationInMs = performance.now() - now;

      return {
        results,
        durationInMs,
      };
    } catch (error) {
      logger.error("Failed to call afterTask", { error, flag, jobId });
    }
  }
}

export const executionRateLimiter = singleton("execution-rate-limiter", getRateLimiter);

function getRateLimiter() {
  if (env.REDIS_HOST && env.REDIS_PORT) {
    if (env.REDIS_READER_HOST) {
      return new RedisRunExecutionRateLimiter({
        cluster: {
          startupNodes: [
            { host: env.REDIS_HOST, port: env.REDIS_PORT },
            { host: env.REDIS_READER_HOST, port: env.REDIS_READER_PORT ?? env.REDIS_PORT },
          ],
          options: {
            keyPrefix: KEY_PREFIX,
            scaleReads: "slave",
            redisOptions: {
              password: env.REDIS_PASSWORD,
              tls: {
                checkServerIdentity: () => {
                  // disable TLS verification
                  return undefined;
                },
              },
              enableAutoPipelining: true,
            },
            dnsLookup: (address, callback) => callback(null, address),
            slotsRefreshTimeout: 10000,
          },
        },
        defaultConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
      });
    } else {
      return new RedisRunExecutionRateLimiter({
        redis: {
          keyPrefix: KEY_PREFIX,
          port: env.REDIS_PORT,
          host: env.REDIS_HOST,
          username: env.REDIS_USERNAME,
          password: env.REDIS_PASSWORD,
          enableAutoPipelining: true,
          ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
        },
        defaultConcurrency: env.DEFAULT_ORG_EXECUTION_CONCURRENCY_LIMIT,
      });
    }
  }
}
