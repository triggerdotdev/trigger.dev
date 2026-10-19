import {
  createCache,
  createLRUMemoryStore,
  DefaultStatefulContext,
  Namespace,
} from "@internal/cache";
import parseDuration from "parse-duration";
import { $replica, webhookReplica } from "~/db.server";
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

/** How long an endpoint id that doesn't resolve is remembered as missing. */
const MISSING_ENDPOINT_TTL_MS = 30_000;

/**
 * Which environment an ingress endpoint id belongs to. An endpoint never moves, so a found id only
 * goes stale when it's deleted. Ids that don't resolve live in their own store, so a flood of made-up
 * ids can't push real endpoints out.
 */
const webhookEndpointEnvironmentCache = singleton("webhookEndpointEnvironmentCache", () =>
  createCache({
    found: new Namespace<{ environmentId: string }>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(10_000)],
      fresh: 5 * 60_000,
      stale: 10 * 60_000,
    }),
    missing: new Namespace<true>(new DefaultStatefulContext(), {
      stores: [createLRUMemoryStore(10_000)],
      fresh: MISSING_ENDPOINT_TTL_MS,
      stale: MISSING_ENDPOINT_TTL_MS,
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
    endpointRateLimitTokens: env.WEBHOOK_INGRESS_RATE_LIMIT_TOKENS,
    endpointRateLimitWindowSeconds: windowSeconds(env.WEBHOOK_INGRESS_RATE_LIMIT_WINDOW),
    environmentRateLimitTokens: env.WEBHOOK_INGRESS_ENV_RATE_LIMIT_TOKENS,
    environmentRateLimitWindowSeconds: windowSeconds(env.WEBHOOK_INGRESS_ENV_RATE_LIMIT_WINDOW),
    queuedPayloadBytes: env.WEBHOOK_QUEUED_PAYLOAD_BYTES_LIMIT,
  };
}

function windowSeconds(duration: string) {
  return Math.max(1, Math.round((parseDuration(duration) ?? 10_000) / 1000));
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

async function cachedEndpointEnvironment(opaqueId: string): Promise<string | null | undefined> {
  const found = await webhookEndpointEnvironmentCache.found.get(opaqueId);
  if (found.val) return found.val.environmentId;
  const missing = await webhookEndpointEnvironmentCache.missing.get(opaqueId);
  return missing.val ? null : undefined;
}

async function endpointEnvironment(opaqueId: string): Promise<string | null | undefined> {
  const missing = await webhookEndpointEnvironmentCache.missing.get(opaqueId);
  if (missing.val) return null;
  const found = await webhookEndpointEnvironmentCache.found.swr(opaqueId, async () => {
    const endpoint = await webhookReplica.webhookEndpoint.findFirst({
      where: { opaqueId },
      select: { runtimeEnvironmentId: true },
    });
    return endpoint ? { environmentId: endpoint.runtimeEnvironmentId } : undefined;
  });
  if (found.err) {
    logger.warn("webhook endpoint environment cache failed, using default limits", {
      opaqueId,
      error: found.err.message,
    });
    return undefined;
  }
  if (found.val) return found.val.environmentId;
  await webhookEndpointEnvironmentCache.missing.set(opaqueId, true);
  return null;
}

/**
 * What the ingress knows about an endpoint id before any other work: whether it exists (undefined
 * when that isn't known), its environment, and the limits of the org that owns it, or the env
 * defaults. The endpoint is
 * read from the webhook database's replica, cached; an id that doesn't resolve is cached as missing
 * for 30 seconds, so a just-created endpoint picks up its org's limits quickly. With `cachedOnly`
 * nothing is read from the database, and an id that isn't cached has an unknown existence.
 */
export async function webhookIngressEndpoint(
  opaqueId: string,
  options: { cachedOnly?: boolean } = {}
): Promise<{ exists: boolean | undefined; environmentId?: string; limits: WebhookLimits }> {
  const environmentId = options.cachedOnly
    ? await cachedEndpointEnvironment(opaqueId)
    : await endpointEnvironment(opaqueId);
  if (!environmentId) {
    return {
      exists: environmentId === null ? false : undefined,
      limits: webhookLimitsFromConfig(null).limits,
    };
  }
  return { exists: true, environmentId, limits: await webhookLimitsForEnvironment(environmentId) };
}
