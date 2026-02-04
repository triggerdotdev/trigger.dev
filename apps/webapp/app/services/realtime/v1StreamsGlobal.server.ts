import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
  RedisCacheStore,
} from "@internal/cache";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { RedisRealtimeStreams } from "./redisRealtimeStreams.server";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";
import { StreamIngestor, StreamResponder } from "./types";

function initializeRedisRealtimeStreams() {
  return new RedisRealtimeStreams({
    redis: {
      port: env.REALTIME_STREAMS_REDIS_PORT,
      host: env.REALTIME_STREAMS_REDIS_HOST,
      username: env.REALTIME_STREAMS_REDIS_USERNAME,
      password: env.REALTIME_STREAMS_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REALTIME_STREAMS_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      keyPrefix: "tr:realtime:streams:",
    },
    inactivityTimeoutMs: env.REALTIME_STREAMS_INACTIVITY_TIMEOUT_MS,
  });
}

export const v1RealtimeStreams = singleton("realtimeStreams", initializeRedisRealtimeStreams);

export function getRealtimeStreamInstance(
  environment: AuthenticatedEnvironment,
  streamVersion: string
): StreamIngestor & StreamResponder {
  if (streamVersion === "v1") {
    return v1RealtimeStreams;
  } else {
    if (env.REALTIME_STREAMS_S2_BASIN && env.REALTIME_STREAMS_S2_ACCESS_TOKEN) {
      return new S2RealtimeStreams({
        basin: env.REALTIME_STREAMS_S2_BASIN,
        accessToken: env.REALTIME_STREAMS_S2_ACCESS_TOKEN,
        streamPrefix: [
          "org",
          environment.organization.id,
          "env",
          environment.slug,
          environment.id,
        ].join("/"),
        logLevel: env.REALTIME_STREAMS_S2_LOG_LEVEL,
        flushIntervalMs: env.REALTIME_STREAMS_S2_FLUSH_INTERVAL_MS,
        maxRetries: env.REALTIME_STREAMS_S2_MAX_RETRIES,
        s2WaitSeconds: env.REALTIME_STREAMS_S2_WAIT_SECONDS,
        accessTokenExpirationInMs: env.REALTIME_STREAMS_S2_ACCESS_TOKEN_EXPIRATION_IN_MS,
        cache: s2RealtimeStreamsCache,
      });
    }

    throw new Error("Realtime streams v2 is required for this run but S2 configuration is missing");
  }
}

export function determineRealtimeStreamsVersion(streamVersion?: string): "v1" | "v2" {
  if (!streamVersion) {
    return env.REALTIME_STREAMS_DEFAULT_VERSION;
  }

  if (
    streamVersion === "v2" &&
    env.REALTIME_STREAMS_S2_BASIN &&
    env.REALTIME_STREAMS_S2_ACCESS_TOKEN
  ) {
    return "v2";
  }

  return "v1";
}

const s2RealtimeStreamsCache = singleton(
  "s2RealtimeStreamsCache",
  initializeS2RealtimeStreamsCache
);

function initializeS2RealtimeStreamsCache() {
  const ctx = new DefaultStatefulContext();
  const redisCacheStore = new RedisCacheStore({
    name: "s2-realtime-streams-cache",
    connection: {
      port: env.REALTIME_STREAMS_REDIS_PORT,
      host: env.REALTIME_STREAMS_REDIS_HOST,
      username: env.REALTIME_STREAMS_REDIS_USERNAME,
      password: env.REALTIME_STREAMS_REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REALTIME_STREAMS_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      keyPrefix: "s2-realtime-streams-cache:",
    },
    useModernCacheKeyBuilder: true,
  });

  const memoryStore = createLRUMemoryStore(5000);

  return createCache({
    accessToken: new Namespace<string>(ctx, {
      stores: [memoryStore, redisCacheStore],
      fresh: Math.floor(env.REALTIME_STREAMS_S2_ACCESS_TOKEN_EXPIRATION_IN_MS / 2),
      stale: Math.floor(env.REALTIME_STREAMS_S2_ACCESS_TOKEN_EXPIRATION_IN_MS / 2 + 60_000),
    }),
  });
}
