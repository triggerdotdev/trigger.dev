import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RedisRealtimeStreams } from "./redisRealtimeStreams.server";

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
  });
}

export const v1RealtimeStreams = singleton("realtimeStreams", initializeRedisRealtimeStreams);
