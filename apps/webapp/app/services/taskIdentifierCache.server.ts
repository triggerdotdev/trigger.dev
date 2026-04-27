import { Redis } from "ioredis";
import type { TaskTriggerSource } from "@trigger.dev/database";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { logger } from "./logger.server";

const KEY_PREFIX = "tids:";

type CachedTaskIdentifier = {
  s: string;
  ts: TaskTriggerSource;
  live: boolean;
};

export type TaskIdentifierEntry = {
  slug: string;
  triggerSource: TaskTriggerSource;
  isInLatestDeployment: boolean;
};

function buildKey(environmentId: string): string {
  return `${KEY_PREFIX}${environmentId}`;
}

function encode(entry: TaskIdentifierEntry): string {
  return JSON.stringify({
    s: entry.slug,
    ts: entry.triggerSource,
    live: entry.isInLatestDeployment,
  } satisfies CachedTaskIdentifier);
}

function decode(raw: string): TaskIdentifierEntry {
  const parsed = JSON.parse(raw) as CachedTaskIdentifier;
  return {
    slug: parsed.s,
    triggerSource: parsed.ts,
    isInLatestDeployment: parsed.live,
  };
}

function initializeRedis(): Redis | undefined {
  const host = env.CACHE_REDIS_HOST;
  if (!host) {
    return undefined;
  }

  return new Redis({
    connectionName: "taskIdentifierCache",
    host,
    port: env.CACHE_REDIS_PORT,
    username: env.CACHE_REDIS_USERNAME,
    password: env.CACHE_REDIS_PASSWORD,
    keyPrefix: "tr:",
    enableAutoPipelining: true,
    ...(env.CACHE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
}

const redis = singleton("taskIdentifierCache", initializeRedis);

export async function populateTaskIdentifierCache(
  environmentId: string,
  identifiers: TaskIdentifierEntry[]
): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(environmentId);
    const pipeline = redis.pipeline();
    pipeline.del(key);
    if (identifiers.length > 0) {
      pipeline.sadd(key, ...identifiers.map(encode));
    }
    await pipeline.exec();
  } catch (error) {
    logger.error("Failed to populate task identifier cache", {
      environmentId,
      error,
    });
  }
}

export async function invalidateTaskIdentifierCache(environmentId: string): Promise<void> {
  if (!redis) return;

  try {
    const key = buildKey(environmentId);
    await redis.del(key);
  } catch (error) {
    logger.error("Failed to invalidate task identifier cache", {
      environmentId,
      error,
    });
  }
}

export async function getTaskIdentifiersFromCache(
  environmentId: string
): Promise<TaskIdentifierEntry[] | null> {
  if (!redis) return null;

  try {
    const key = buildKey(environmentId);
    const members = await redis.smembers(key);
    if (members.length === 0) return null;
    return members.map(decode);
  } catch (error) {
    logger.error("Failed to get task identifiers from cache", {
      environmentId,
      error,
    });
    return null;
  }
}
