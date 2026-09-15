import { env } from "~/env.server";
import { createRedisClient } from "~/redis.server";
import { singleton } from "~/utils/singleton";

const RECONCILE_QUEUE_KEY = "billing-limit:reconcile-queue";

function createQueueRedis() {
  return createRedisClient("billing-limit:reconcile", {
    keyPrefix: "",
    host: env.BILLING_LIMIT_WORKER_REDIS_HOST,
    port: env.BILLING_LIMIT_WORKER_REDIS_PORT,
    username: env.BILLING_LIMIT_WORKER_REDIS_USERNAME,
    password: env.BILLING_LIMIT_WORKER_REDIS_PASSWORD,
    tlsDisabled: env.BILLING_LIMIT_WORKER_REDIS_TLS_DISABLED === "true",
  });
}

const queueRedis = singleton("billingLimitReconcileQueueRedis", createQueueRedis);

export async function seedBillingLimitReconcileQueue(organizationId: string): Promise<void> {
  await queueRedis.sadd(RECONCILE_QUEUE_KEY, organizationId);
}

export async function readBillingLimitReconcileQueue(): Promise<string[]> {
  return queueRedis.smembers(RECONCILE_QUEUE_KEY);
}

export async function removeFromBillingLimitReconcileQueue(
  organizationIds: string[]
): Promise<void> {
  if (organizationIds.length === 0) {
    return;
  }
  await queueRedis.srem(RECONCILE_QUEUE_KEY, ...organizationIds);
}
