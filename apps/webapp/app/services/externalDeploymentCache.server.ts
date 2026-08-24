import type { Callback, Redis, Result } from "ioredis";
import { logger } from "./logger.server";

export type ExternalDeploymentCacheEntry = {
  workerId: string;
  version: string;
  sdkVersion: string;
  cliVersion: string;
};

export type ExternalDeploymentCacheResult =
  | { outcome: "deployed"; entry: ExternalDeploymentCacheEntry }
  | { outcome: "missing" };

export interface ExternalDeploymentCache {
  get(environmentId: string, externalId: string): Promise<ExternalDeploymentCacheResult | null>;
  setIfNewer(
    environmentId: string,
    externalId: string,
    entry: ExternalDeploymentCacheEntry
  ): Promise<void>;
  setMissing(environmentId: string, externalId: string): Promise<void>;
}

const KEY_PREFIX = "skewid:";

const DEFAULT_TTL_SECONDS = 30 * 24 * 60 * 60;

const DEFAULT_MISSING_TTL_SECONDS = 20;

const MISSING_ENTRY = JSON.stringify({ m: 1 });

function buildKey(environmentId: string, externalId: string): string {
  return `${KEY_PREFIX}${environmentId}:${externalId}`;
}

type CachedEntry = {
  w: string;
  v: string;
  s: string;
  c: string;
};

function encode(entry: ExternalDeploymentCacheEntry): string {
  return JSON.stringify({
    w: entry.workerId,
    v: entry.version,
    s: entry.sdkVersion,
    c: entry.cliVersion,
  } satisfies CachedEntry);
}

function decode(raw: string): ExternalDeploymentCacheResult | null {
  const parsed: unknown = JSON.parse(raw);

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const { w, v, s, c, m } = parsed as Partial<CachedEntry> & { m?: unknown };

  if (m === 1) {
    return { outcome: "missing" };
  }

  if (typeof w !== "string" || typeof v !== "string") {
    return null;
  }

  return {
    outcome: "deployed",
    entry: {
      workerId: w,
      version: v,
      sdkVersion: typeof s === "string" ? s : "",
      cliVersion: typeof c === "string" ? c : "",
    },
  };
}

const SET_IF_NEWER_LUA = `
local existing = redis.call("GET", KEYS[1])

if existing then
  local ok, decoded = pcall(cjson.decode, existing)
  if ok and type(decoded) == "table" and type(decoded.v) == "string" then
    local existingDate, existingCounter = string.match(decoded.v, "^([^.]*)%.?(.*)$")
    local incomingDate, incomingCounter = string.match(ARGV[2], "^([^.]*)%.?(.*)$")

    if existingDate > incomingDate then
      return 0
    end

    if existingDate == incomingDate then
      if (tonumber(existingCounter) or 0) >= (tonumber(incomingCounter) or 0) then
        return 0
      end
    end
  end
end

redis.call("SET", KEYS[1], ARGV[1], "EX", tonumber(ARGV[3]))
return 1
`;

declare module "ioredis" {
  interface RedisCommander<Context> {
    skewIdSetIfNewer(
      key: string,
      entry: string,
      version: string,
      ttlSeconds: string,
      callback?: Callback<number>
    ): Result<number, Context>;
  }
}

export type RedisExternalDeploymentCacheOptions = {
  redis: Redis;
  ttlSeconds?: number;
  missingTtlSeconds?: number;
};

export class RedisExternalDeploymentCache implements ExternalDeploymentCache {
  private readonly redis: Redis;
  private readonly ttlSeconds: number;
  private readonly missingTtlSeconds: number;

  constructor(options: RedisExternalDeploymentCacheOptions) {
    this.redis = options.redis;
    this.ttlSeconds = options.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    this.missingTtlSeconds = options.missingTtlSeconds ?? DEFAULT_MISSING_TTL_SECONDS;

    this.redis.defineCommand("skewIdSetIfNewer", { numberOfKeys: 1, lua: SET_IF_NEWER_LUA });
  }

  async get(
    environmentId: string,
    externalId: string
  ): Promise<ExternalDeploymentCacheResult | null> {
    try {
      const raw = await this.redis.get(buildKey(environmentId, externalId));
      if (!raw) return null;
      return decode(raw);
    } catch (error) {
      logger.error("Failed to read external deployment resolution from cache", {
        environmentId,
        externalId,
        error,
      });
      return null;
    }
  }

  async setIfNewer(
    environmentId: string,
    externalId: string,
    entry: ExternalDeploymentCacheEntry
  ): Promise<void> {
    try {
      await this.redis.skewIdSetIfNewer(
        buildKey(environmentId, externalId),
        encode(entry),
        entry.version,
        String(this.ttlSeconds)
      );
    } catch (error) {
      logger.error("Failed to write external deployment resolution to cache", {
        environmentId,
        externalId,
        version: entry.version,
        error,
      });

      try {
        await this.redis.del(buildKey(environmentId, externalId));
      } catch (deleteError) {
        logger.error("Failed to evict stale external deployment resolution after write failure", {
          environmentId,
          externalId,
          error: deleteError,
        });
      }
    }
  }

  async setMissing(environmentId: string, externalId: string): Promise<void> {
    try {
      await this.redis.set(
        buildKey(environmentId, externalId),
        MISSING_ENTRY,
        "EX",
        this.missingTtlSeconds,
        "NX"
      );
    } catch (error) {
      logger.error("Failed to write missing external deployment marker to cache", {
        environmentId,
        externalId,
        error,
      });
    }
  }
}

export class NoopExternalDeploymentCache implements ExternalDeploymentCache {
  async get(): Promise<ExternalDeploymentCacheResult | null> {
    return null;
  }

  async setIfNewer(): Promise<void> {}

  async setMissing(): Promise<void> {}
}
