import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
  RedisCacheStore,
} from "@internal/cache";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import type { AuthenticatedEnvironment } from "../apiAuth.server";
import { RedisRealtimeStreams } from "./redisRealtimeStreams.server";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";
import {
  resolveRealtimeStreamsVersion,
  type RealtimeStreamsVersionConfig,
} from "./realtimeStreamsVersion";
import type { StreamIngestor, StreamResponder } from "./types";

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

const v1RealtimeStreams = singleton("realtimeStreams", initializeRedisRealtimeStreams);

/**
 * Resolve a stream's basin. Precedence: run → session → org → global env.
 * Pre-migration rows have `streamBasinName: null` and fall through to
 * the global basin (where their streams actually live), so only pass
 * `organization` when no run/session row exists at all — otherwise a
 * null column would short-circuit to the org's *current* basin.
 */
export type StreamBasinContext = {
  run?: { streamBasinName: string | null } | null;
  session?: { streamBasinName: string | null } | null;
  organization?: { streamBasinName: string | null } | null;
};

export function resolveStreamBasin(ctx: StreamBasinContext): string | undefined {
  return (
    ctx.run?.streamBasinName ??
    ctx.session?.streamBasinName ??
    ctx.organization?.streamBasinName ??
    env.REALTIME_STREAMS_S2_BASIN ??
    undefined
  );
}

export function getRealtimeStreamInstance(
  environment: AuthenticatedEnvironment,
  streamVersion: string,
  basinContext?: StreamBasinContext
): StreamIngestor & StreamResponder {
  if (streamVersion === "v1") {
    return v1RealtimeStreams;
  }

  const resolvedBasin = resolveStreamBasin(basinContext ?? {});
  if (
    resolvedBasin &&
    (env.REALTIME_STREAMS_S2_ACCESS_TOKEN || env.REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS === "true")
  ) {
    return new S2RealtimeStreams({
      basin: resolvedBasin,
      accessToken: env.REALTIME_STREAMS_S2_ACCESS_TOKEN ?? "",
      endpoint: env.REALTIME_STREAMS_S2_ENDPOINT,
      accountUrl: env.REALTIME_STREAMS_S2_ACCOUNT_URL,
      basinUrl: env.REALTIME_STREAMS_S2_BASIN_URL,
      skipAccessTokens: env.REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS === "true",
      streamPrefix: streamPrefixFor(environment, resolvedBasin),
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

// Shared basin needs `org/{orgId}` to namespace; per-org basin already
// isolates so the segment drops.
function streamPrefixFor(environment: AuthenticatedEnvironment, basin: string): string {
  const isPerOrgBasin = basin !== env.REALTIME_STREAMS_S2_BASIN;
  const segments = isPerOrgBasin
    ? ["env", environment.slug, environment.id]
    : ["org", environment.organization.id, "env", environment.slug, environment.id];
  return segments.join("/");
}

/**
 * Pass `organizationBasinName` wherever the caller has it. It mirrors the
 * organization step of {@link resolveStreamBasin}, and is what lets a
 * per-org-basin deployment with no global setting resolve v2 for a
 * provisioned organization while an unprovisioned one still degrades to v1.
 */
export function determineRealtimeStreamsVersion(
  streamVersion?: string,
  organizationBasinName?: string | null
): "v1" | "v2" {
  return resolveRealtimeStreamsVersion(streamVersion, {
    defaultVersion: env.REALTIME_STREAMS_DEFAULT_VERSION,
    basin: organizationBasinName ?? env.REALTIME_STREAMS_S2_BASIN,
    accessToken: env.REALTIME_STREAMS_S2_ACCESS_TOKEN,
    skipAccessTokens: env.REALTIME_STREAMS_S2_SKIP_ACCESS_TOKENS === "true",
  });
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
