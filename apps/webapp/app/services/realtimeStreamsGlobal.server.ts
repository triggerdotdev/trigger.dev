import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { RealtimeStreams } from "./realtimeStreams.server";

function initializeRealtimeStreams() {
  return new RealtimeStreams({
    redis: {
      port: env.REDIS_PORT,
      host: env.REDIS_HOST,
      username: env.REDIS_USERNAME,
      password: env.REDIS_PASSWORD,
      enableAutoPipelining: true,
      ...(env.REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
      keyPrefix: "tr:realtime:streams:",
    },
  });
}

export const realtimeStreams = singleton("realtimeStreams", initializeRealtimeStreams);
