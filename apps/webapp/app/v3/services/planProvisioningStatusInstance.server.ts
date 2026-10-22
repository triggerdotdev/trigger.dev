import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";
import { readPlanProvisioningStatus } from "./planProvisioningStatus.server";

// redis_alt, which billing writes the status to through its REDIS_* connection. Fails fast: the
// status is a banner and must not hold up the billing page.
const redis = singleton("planProvisioningStatusRedis", () =>
  createRedisClient("trigger:plan-provisioning-status", {
    host: env.COMMON_WORKER_REDIS_HOST,
    port: env.COMMON_WORKER_REDIS_PORT,
    username: env.COMMON_WORKER_REDIS_USERNAME,
    password: env.COMMON_WORKER_REDIS_PASSWORD,
    tlsDisabled: env.COMMON_WORKER_REDIS_TLS_DISABLED === "true",
    clusterMode: env.COMMON_WORKER_REDIS_CLUSTER_MODE_ENABLED === "1",
    commandTimeout: 1_000,
    maxRetriesPerRequest: 1,
  })
);

export function getPlanProvisioningStatus(organizationId: string) {
  return readPlanProvisioningStatus(redis, organizationId);
}
