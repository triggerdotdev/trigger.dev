import { createRedisClient } from "@internal/redis";
import { prisma, $transaction } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { EnvironmentEncryptionBackfill } from "./backfill.server";
import { environmentEncryption } from "./instance.server";

export const environmentEncryptionBackfill = singleton("environmentEncryptionBackfill", () => {
  const redis = createRedisClient({
    host: env.ADMIN_WORKER_REDIS_HOST,
    port: env.ADMIN_WORKER_REDIS_PORT,
    username: env.ADMIN_WORKER_REDIS_USERNAME,
    password: env.ADMIN_WORKER_REDIS_PASSWORD,
    ...(env.ADMIN_WORKER_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
  });
  return new EnvironmentEncryptionBackfill({
    db: prisma,
    redis,
    encryption: environmentEncryption(),
    transaction: (fn) => $transaction(prisma, "environment encryption backfill", fn),
  });
});
