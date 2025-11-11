import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RedisRealtimeStreams } from "./redisRealtimeStreams.server";
import { AuthenticatedEnvironment } from "../apiAuth.server";
import { StreamIngestor, StreamResponder } from "./types";
import { S2RealtimeStreams } from "./s2realtimeStreams.server";

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
      });
    }

    throw new Error("Realtime streams v2 is required for this run but S2 configuration is missing");
  }
}
