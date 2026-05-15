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
  /** Read a slug's metadata from the env keyspace (current pointer). */
  getCurrent(envId: string, slug: string): Promise<TaskMetadataEntry | null>;
  /** Read a slug's metadata from the by-worker keyspace (locked-version lookups). */
  getByWorker(workerId: string, slug: string): Promise<TaskMetadataEntry | null>;
  /**
   * Atomically replace both `task-meta:env:{envId}` and
   * `task-meta:by-worker:{workerId}` with the given entries. Used at deploy
   * promotion sites where the worker just became current for the env.
   */
  populateByCurrentWorker(
    envId: string,
    workerId: string,
    entries: TaskMetadataEntry[]
  ): Promise<void>;
  /**
   * Replace `task-meta:by-worker:{workerId}` only. Used at deploy build sites
   * (V4) where the worker is created but not yet promoted.
   */
  populateByWorker(workerId: string, entries: TaskMetadataEntry[]): Promise<void>;
  /**
   * Atomically upsert one slug in both keyspaces. Used by the non-locked
   * read-path back-fill. The env-keyspace TTL is only set when no TTL is
   * present (preserves the promotion boundary); the by-worker TTL is
   * refreshed on every call (sliding expiry).
   */
  setByCurrentWorker(envId: string, workerId: string, entry: TaskMetadataEntry): Promise<void>;
  /**
   * Upsert one slug in `task-meta:by-worker:{workerId}` only. Used by the
   * locked-version read-path back-fill; refreshes the by-worker TTL.
   */
  setByWorker(workerId: string, entry: TaskMetadataEntry): Promise<void>;
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
 * Atomically replace a single HASH's contents and reset its TTL.
 *
 * KEYS[1] = hash key
 * ARGV[1] = ttl seconds (0 = no TTL)
 * ARGV[2..N] = alternating field, value pairs
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
 * Reserved field name on env hashes that records the worker currently
 * "owning" the env keyspace. The back-fill Lua script reads this and skips
 * its env-side write if the owner has flipped — closing the race where a
 * concurrent promotion atomically replaces the env hash between a resolver's
 * PG read and its back-fill write. Customer task slugs are kebab/camelCase
 * and never start with `__`, so collisions are not a concern; an accidental
 * `getCurrent(envId, "__owner_worker_id")` would JSON.parse-fail and fall
 * back to PG, not corrupt anything.
 */
const OWNER_FIELD = "__owner_worker_id";

/**
 * Atomically replace BOTH keyspaces in one Redis transaction. Used at deploy
 * promotion — the worker just became current for the env, so the env keyspace
 * and the worker keyspace get the same field set, and the env hash is
 * stamped with the new owner workerId.
 *
 * KEYS[1] = env hash key
 * KEYS[2] = by-worker hash key
 * ARGV[1] = env ttl seconds (0 = no TTL)
 * ARGV[2] = by-worker ttl seconds (0 = no TTL)
 * ARGV[3] = workerId (env-hash owner marker)
 * ARGV[4..N] = alternating field, value pairs (same for both hashes)
 */
const REPLACE_TWO_HASHES_LUA = `
redis.call("DEL", KEYS[1])
redis.call("DEL", KEYS[2])
if #ARGV > 3 then
  local fv = {}
  for i = 4, #ARGV do
    fv[#fv + 1] = ARGV[i]
  end
  redis.call("HSET", KEYS[1], unpack(fv))
  redis.call("HSET", KEYS[2], unpack(fv))
end
redis.call("HSET", KEYS[1], "${OWNER_FIELD}", ARGV[3])
local envTtl = tonumber(ARGV[1])
if envTtl and envTtl > 0 then
  redis.call("EXPIRE", KEYS[1], envTtl)
end
local workerTtl = tonumber(ARGV[2])
if workerTtl and workerTtl > 0 then
  redis.call("EXPIRE", KEYS[2], workerTtl)
end
return 1
`;

/**
 * Set a single field and refresh the HASH TTL. Used by the locked-version
 * back-fill path — sliding expiry keeps active workers warm.
 *
 * KEYS[1] = hash key
 * ARGV[1] = ttl seconds (0 = no TTL refresh)
 * ARGV[2] = field
 * ARGV[3] = value
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
 * Atomically upsert one field in BOTH keyspaces. Used by the non-locked
 * back-fill path.
 *
 * The by-worker hash always gets written (the key contains the workerId, so
 * stale data lands in a dead worker's keyspace and is never read by anyone
 * not pinned to that version).
 *
 * The env hash is CAS-guarded by `${OWNER_FIELD}`: if a concurrent promotion
 * has replaced the hash between this resolver's PG read and this write, the
 * stored owner won't match the workerId the back-filler resolved to, so the
 * env write is skipped — preventing the back-fill from overwriting a freshly
 * promoted slug with stale data from the previous worker.
 *
 * KEYS[1] = env hash key
 * KEYS[2] = by-worker hash key
 * ARGV[1] = env ttl seconds (0 = no TTL)
 * ARGV[2] = by-worker ttl seconds (0 = no TTL)
 * ARGV[3] = writer's expected env-hash owner workerId
 * ARGV[4] = field
 * ARGV[5] = value
 */
const SET_TWO_FIELDS_LUA = `
redis.call("HSET", KEYS[2], ARGV[4], ARGV[5])
local workerTtl = tonumber(ARGV[2])
if workerTtl and workerTtl > 0 then
  redis.call("EXPIRE", KEYS[2], workerTtl)
end

local owner = redis.call("HGET", KEYS[1], "${OWNER_FIELD}")
if owner == false or owner == ARGV[3] then
  redis.call("HSET", KEYS[1], ARGV[4], ARGV[5])
  if owner == false then
    redis.call("HSET", KEYS[1], "${OWNER_FIELD}", ARGV[3])
  end
  local envTtl = tonumber(ARGV[1])
  if envTtl and envTtl > 0 and redis.call("TTL", KEYS[1]) == -1 then
    redis.call("EXPIRE", KEYS[1], envTtl)
  end
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
    taskMetaReplaceTwoHashes(
      envKey: string,
      workerKey: string,
      envTtlSeconds: string,
      workerTtlSeconds: string,
      workerId: string,
      ...fieldValues: string[]
    ): Result<number, Context>;
    taskMetaSetFieldRefreshTtl(
      key: string,
      ttlSeconds: string,
      field: string,
      value: string,
      callback?: Callback<number>
    ): Result<number, Context>;
    taskMetaSetTwoFields(
      envKey: string,
      workerKey: string,
      envTtlSeconds: string,
      workerTtlSeconds: string,
      workerId: string,
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
    this.redis.defineCommand("taskMetaReplaceTwoHashes", {
      numberOfKeys: 2,
      lua: REPLACE_TWO_HASHES_LUA,
    });
    this.redis.defineCommand("taskMetaSetFieldRefreshTtl", {
      numberOfKeys: 1,
      lua: SET_FIELD_REFRESH_TTL_LUA,
    });
    this.redis.defineCommand("taskMetaSetTwoFields", {
      numberOfKeys: 2,
      lua: SET_TWO_FIELDS_LUA,
    });
  }

  async getCurrent(envId: string, slug: string): Promise<TaskMetadataEntry | null> {
    return this.#get(currentEnvKey(envId), slug);
  }

  async getByWorker(workerId: string, slug: string): Promise<TaskMetadataEntry | null> {
    return this.#get(byWorkerKey(workerId), slug);
  }

  async populateByCurrentWorker(
    envId: string,
    workerId: string,
    entries: TaskMetadataEntry[]
  ): Promise<void> {
    try {
      // Always invoke the script — empty `entries` is valid and causes both
      // keyspaces to be cleared (DEL + no HSET), which is the right behavior
      // when promoting a worker with no tasks.
      const fieldValues: string[] = [];
      for (const entry of entries) {
        fieldValues.push(entry.slug, encode(entry));
      }
      await this.redis.taskMetaReplaceTwoHashes(
        currentEnvKey(envId),
        byWorkerKey(workerId),
        String(this.currentEnvTtlSeconds),
        String(this.byWorkerTtlSeconds),
        workerId,
        ...fieldValues
      );
    } catch (error) {
      logger.error("Failed to populate task metadata cache (current worker)", {
        envId,
        workerId,
        error,
      });
    }
  }

  async populateByWorker(workerId: string, entries: TaskMetadataEntry[]): Promise<void> {
    try {
      // Always invoke the script — empty `entries` clears the keyspace.
      const fieldValues: string[] = [];
      for (const entry of entries) {
        fieldValues.push(entry.slug, encode(entry));
      }
      await this.redis.taskMetaReplaceHash(
        byWorkerKey(workerId),
        String(this.byWorkerTtlSeconds),
        ...fieldValues
      );
    } catch (error) {
      logger.error("Failed to populate task metadata cache (by worker)", {
        workerId,
        error,
      });
    }
  }

  async setByCurrentWorker(
    envId: string,
    workerId: string,
    entry: TaskMetadataEntry
  ): Promise<void> {
    try {
      await this.redis.taskMetaSetTwoFields(
        currentEnvKey(envId),
        byWorkerKey(workerId),
        String(this.currentEnvTtlSeconds),
        String(this.byWorkerTtlSeconds),
        workerId,
        entry.slug,
        encode(entry)
      );
    } catch (error) {
      logger.error("Failed to set task metadata cache field (current worker)", {
        envId,
        workerId,
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
      logger.error("Failed to set task metadata cache field (by worker)", {
        workerId,
        slug: entry.slug,
        error,
      });
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
}

export class NoopTaskMetadataCache implements TaskMetadataCache {
  async getCurrent(): Promise<TaskMetadataEntry | null> {
    return null;
  }

  async getByWorker(): Promise<TaskMetadataEntry | null> {
    return null;
  }

  async populateByCurrentWorker(): Promise<void> {
    // intentionally empty
  }

  async populateByWorker(): Promise<void> {
    // intentionally empty
  }

  async setByCurrentWorker(): Promise<void> {
    // intentionally empty
  }

  async setByWorker(): Promise<void> {
    // intentionally empty
  }
}
