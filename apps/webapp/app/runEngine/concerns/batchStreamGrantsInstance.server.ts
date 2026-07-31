import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { BatchStreamGrants } from "./batchStreamGrants.server";

export const batchStreamGrants = singleton(
  "batchStreamGrants",
  () =>
    new BatchStreamGrants({
      redis: {
        port: env.RATE_LIMIT_REDIS_PORT,
        host: env.RATE_LIMIT_REDIS_HOST,
        username: env.RATE_LIMIT_REDIS_USERNAME,
        password: env.RATE_LIMIT_REDIS_PASSWORD,
        tlsDisabled: env.RATE_LIMIT_REDIS_TLS_DISABLED === "true",
        clusterMode: env.RATE_LIMIT_REDIS_CLUSTER_MODE_ENABLED === "1",
      },
      attempts: env.BATCH_STREAM_GRANT_ATTEMPTS,
      ttlMs: env.BATCH_SEAL_TIMEOUT_MS,
    })
);
