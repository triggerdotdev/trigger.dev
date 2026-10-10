import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { singleton } from "~/utils/singleton";
import {
  resolveWebhookLimits,
  type WebhookLimits,
  type WebhookLimitsDefaults,
} from "./webhookLimits";

/**
 * Per-process: fresh for 5 minutes, then served stale for up to another 5 while one background load
 * refreshes it. Concurrent loads of the same environment share one query.
 */
const webhookLimitsCache = singleton("webhookLimitsCache", () =>
  createCache({
    limits: new Namespace<WebhookLimits>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(10_000)],
      fresh: 5 * 60_000,
      stale: 10 * 60_000,
    }),
  })
);

function defaults(): WebhookLimitsDefaults {
  return {
    maxWaitersPerEnvironment: env.WEBHOOK_WAITER_MAX_PER_ENVIRONMENT,
    maxWaitersPerEndpoint: env.WEBHOOK_WAITER_MAX_PER_ENDPOINT,
    concurrency: env.WEBHOOK_WORKER_TENANT_CONCURRENCY,
    deliveryRetentionDays: env.WEBHOOK_DELIVERY_RETENTION_DAYS,
    deliveryStorageDays: env.WEBHOOK_DELIVERY_STORAGE_DAYS,
  };
}

/** The org's webhook limits over the env defaults, and which fields the org sets. */
export function webhookLimitsFromConfig(config: unknown) {
  return resolveWebhookLimits(config, defaults());
}

async function loadWebhookLimits(environmentId: string): Promise<WebhookLimits> {
  const environment = await $replica.runtimeEnvironment.findFirst({
    where: { id: environmentId },
    select: { organization: { select: { webhookLimitsConfig: true } } },
  });
  return webhookLimitsFromConfig(environment?.organization.webhookLimitsConfig).limits;
}

/**
 * The webhook limits for an environment's org, read on every waiter create and fair-queue claim. A
 * plan or back-office change reaches a process within about 10 minutes.
 */
export async function webhookLimitsForEnvironment(environmentId: string): Promise<WebhookLimits> {
  const result = await webhookLimitsCache.limits.swr(environmentId, () =>
    loadWebhookLimits(environmentId)
  );
  if (result.err || !result.val) {
    if (result.err) {
      logger.warn("webhook limits cache failed, reading the org directly", {
        environmentId,
        error: result.err.message,
      });
    }
    return loadWebhookLimits(environmentId);
  }
  return result.val;
}
