import type { Redis, Result, Callback } from "ioredis";
import type { TaskTriggerSource } from "@trigger.dev/database";
import { logger } from "./logger.server";

export type TaskMetadataEntry = {
  slug: string;
  ttl: string | null;
  triggerSource: TaskTriggerSource;
  queueId: string | null;
  queueName: string;
};

export interface TaskMetadataCache {
  getCurrent(envId: string, slug: string): Promise<TaskMetadataEntry | null>;
  getByWorker(workerId: string, slug: string): Promise<TaskMetadataEntry | null>;
  populateCurrent(envId: string, entries: TaskMetadataEntry[]): Promise<void>;
  populateByWorker(workerId: string, entries: TaskMetadataEntry[]): Promise<void>;
  /** Add a single field to the env keyspace without resetting the hash TTL. */
  setCurrent(envId: string, entry: TaskMetadataEntry): Promise<void>;
  /** Add a single field to the by-worker keyspace and refresh the hash TTL. */
  setByWorker(workerId: string, entry: TaskMetadataEntry): Promise<void>;
  invalidateCurrent(envId: string): Promise<void>;
}

export type RedisTaskMetadataCacheOptions = {
  redis: Redis;
  /** Safety TTL on `task-meta:env:{envId}`. Default 24h. Use 0 for no expiry. */
  currentEnvTtlSeconds?: number;
  /** Idle TTL on `task-meta:by-worker:{workerId}`. Default 30d. Use 0 for no expiry. */
  byWorkerTtlSeconds?: number;
};

type EncodedEntry = {
  t: string | null;
  k: TaskTriggerSource;
  q: string | null;
  n: string;
};

function encode(entry: TaskMetadataEntry): string {
  const payload: EncodedEntry = {
    t: entry.ttl,
    k: entry.triggerSource,
    q: entry.queueId,
    n: entry.queueName,
  };
  return JSON.stringify(payload);
}

function decode(slug: string, raw: string): TaskMetadataEntry | null {
  try {
    const parsed = JSON.parse(raw) as EncodedEntry;
    return {
      slug,
      ttl: parsed.t,
      triggerSource: parsed.k,
      queueId: parsed.q,
      queueName: parsed.n,
    };
  } catch (error) {
    logger.error("Failed to decode task metadata cache entry", { slug, error });
    return null;
  }
}

function currentEnvKey(envId: string): string {
  return `task-meta:env:${envId}`;
}

function byWorkerKey(workerId: string): string {
  return `task-meta:by-worker:${workerId}`;
}

/**
 * Atomically replace a HASH's contents and reset its TTL.
 *
 * KEYS[1] = hash key
 * ARGV[1] = ttl seconds (0 = no TTL)
 * ARGV[2..N] = alternating field, value pairs
 *
 * One round-trip; readers never observe the empty intermediate state that a
 * naive DEL + HSET pipeline exposes.
 */
const REPLACE_HASH_LUA = `
redis.call("DEL", KEYS[1])
if #ARGV > 1 then
  local fv = {}
  for i = 2, #ARGV do
    fv[#fv + 1] = ARGV[i]
  end
  redis.call("HSET", KEYS[1], unpack(fv))
end
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return 1
`;

/**
 * Set a single field and refresh the HASH TTL.
 *
 * KEYS[1] = hash key
 * ARGV[1] = ttl seconds (0 = no TTL refresh)
 * ARGV[2] = field
 * ARGV[3] = value
 *
 * Used by the by-worker back-fill path — sliding-window expiry keeps active
 * workers warm and lets idle workers age out.
 */
const SET_FIELD_REFRESH_TTL_LUA = `
redis.call("HSET", KEYS[1], ARGV[2], ARGV[3])
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return 1
`;

/**
 * Set a single field and only set the HASH TTL if no TTL is set yet.
 *
 * KEYS[1] = hash key
 * ARGV[1] = ttl seconds (0 = no TTL)
 * ARGV[2] = field
 * ARGV[3] = value
 *
 * Used by the env back-fill path — the env keyspace TTL boundary is owned by
 * `populateCurrent` (called at promotion). Back-fills shouldn't extend it; if
 * a hash already has a TTL, we leave it alone so the safety net still expires
 * on schedule.
 */
const SET_FIELD_PRESERVE_TTL_LUA = `
redis.call("HSET", KEYS[1], ARGV[2], ARGV[3])
local ttl = tonumber(ARGV[1])
if ttl and ttl > 0 and redis.call("TTL", KEYS[1]) == -1 then
  redis.call("EXPIRE", KEYS[1], ttl)
end
return 1
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    taskMetaReplaceHash(
      key: string,
      ttlSeconds: string,
      ...fieldValues: string[]
    ): Result<number, Context>;
    taskMetaSetFieldRefreshTtl(
      key: string,
      ttlSeconds: string,
      field: string,
      value: string,
      callback?: Callback<number>
    ): Result<number, Context>;
    taskMetaSetFieldPreserveTtl(
      key: string,
      ttlSeconds: string,
      field: string,
      value: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}

export class RedisTaskMetadataCache implements TaskMetadataCache {
  private readonly redis: Redis;
  private readonly currentEnvTtlSeconds: number;
  private readonly byWorkerTtlSeconds: number;

  constructor(options: RedisTaskMetadataCacheOptions) {
    this.redis = options.redis;
    this.currentEnvTtlSeconds = options.currentEnvTtlSeconds ?? 86400;
    this.byWorkerTtlSeconds = options.byWorkerTtlSeconds ?? 30 * 24 * 60 * 60;

    this.redis.defineCommand("taskMetaReplaceHash", {
      numberOfKeys: 1,
      lua: REPLACE_HASH_LUA,
    });
    this.redis.defineCommand("taskMetaSetFieldRefreshTtl", {
      numberOfKeys: 1,
      lua: SET_FIELD_REFRESH_TTL_LUA,
    });
    this.redis.defineCommand("taskMetaSetFieldPreserveTtl", {
      numberOfKeys: 1,
      lua: SET_FIELD_PRESERVE_TTL_LUA,
    });
  }

  async getCurrent(envId: string, slug: string): Promise<TaskMetadataEntry | null> {
    return this.#get(currentEnvKey(envId), slug);
  }

  async getByWorker(workerId: string, slug: string): Promise<TaskMetadataEntry | null> {
    return this.#get(byWorkerKey(workerId), slug);
  }

  async populateCurrent(envId: string, entries: TaskMetadataEntry[]): Promise<void> {
    await this.#replaceHash(currentEnvKey(envId), entries, this.currentEnvTtlSeconds);
  }

  async populateByWorker(workerId: string, entries: TaskMetadataEntry[]): Promise<void> {
    await this.#replaceHash(byWorkerKey(workerId), entries, this.byWorkerTtlSeconds);
  }

  async setCurrent(envId: string, entry: TaskMetadataEntry): Promise<void> {
    try {
      await this.redis.taskMetaSetFieldPreserveTtl(
        currentEnvKey(envId),
        String(this.currentEnvTtlSeconds),
        entry.slug,
        encode(entry)
      );
    } catch (error) {
      logger.error("Failed to set task metadata current cache field", {
        envId,
        slug: entry.slug,
        error,
      });
    }
  }

  async setByWorker(workerId: string, entry: TaskMetadataEntry): Promise<void> {
    try {
      await this.redis.taskMetaSetFieldRefreshTtl(
        byWorkerKey(workerId),
        String(this.byWorkerTtlSeconds),
        entry.slug,
        encode(entry)
      );
    } catch (error) {
      logger.error("Failed to set task metadata by-worker cache field", {
        workerId,
        slug: entry.slug,
        error,
      });
    }
  }

  async invalidateCurrent(envId: string): Promise<void> {
    try {
      await this.redis.del(currentEnvKey(envId));
    } catch (error) {
      logger.error("Failed to invalidate task metadata current cache", { envId, error });
    }
  }

  async #get(key: string, slug: string): Promise<TaskMetadataEntry | null> {
    try {
      const raw = await this.redis.hget(key, slug);
      if (!raw) return null;
      return decode(slug, raw);
    } catch (error) {
      logger.error("Failed to read task metadata from cache", { key, slug, error });
      return null;
    }
  }

  async #replaceHash(
    key: string,
    entries: TaskMetadataEntry[],
    ttlSeconds: number
  ): Promise<void> {
    try {
      const argv: string[] = [String(ttlSeconds)];
      for (const entry of entries) {
        argv.push(entry.slug, encode(entry));
      }
      await this.redis.taskMetaReplaceHash(key, ...argv);
    } catch (error) {
      logger.error("Failed to replace task metadata cache hash", { key, error });
    }
  }
}

export class NoopTaskMetadataCache implements TaskMetadataCache {
  async getCurrent(): Promise<TaskMetadataEntry | null> {
    return null;
  }

  async getByWorker(): Promise<TaskMetadataEntry | null> {
    return null;
  }

  async populateCurrent(): Promise<void> {
    // intentionally empty
  }

  async populateByWorker(): Promise<void> {
    // intentionally empty
  }

  async setCurrent(): Promise<void> {
    // intentionally empty
  }

  async setByWorker(): Promise<void> {
    // intentionally empty
  }

  async invalidateCurrent(): Promise<void> {
    // intentionally empty
  }
}
