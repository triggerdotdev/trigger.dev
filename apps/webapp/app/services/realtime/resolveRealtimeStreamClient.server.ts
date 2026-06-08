import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { logger } from "../logger.server";
import { type RealtimeEnvironment } from "../realtimeClient.server";
import { realtimeClient } from "../realtimeClientGlobal.server";
import { BoundedTtlCache } from "./boundedTtlCache";
import { type RealtimeStreamClient } from "./notifierRealtimeClient.server";
import { getNotifierRealtimeClient } from "./notifierRealtimeClientInstance.server";
import { getShadowRealtimeClient } from "./shadowRealtimeClientInstance.server";

type RealtimeBackend = "electric" | "notifier" | "shadow";

/**
 * Chooses which backend serves a realtime run request.
 *
 * Two gates, both defaulting to the Electric path:
 *  1. `REALTIME_NOTIFIER_ENABLED` (env master switch). When off, this returns the
 *     Electric client immediately — no flag read, no notifier client construction,
 *     byte-identical to pre-Electric-Sunset behavior.
 *  2. the `realtimeBackend` feature flag (global + per-org, org wins), resolved per
 *     org and cached in-process for 30s so the long-poll feed doesn't hit the DB
 *     on every request.
 */
const notifierEnabled = env.REALTIME_NOTIFIER_ENABLED === "1";
const BACKEND_CACHE_TTL_MS = 30_000;
// Org count is bounded, but cap to avoid unbounded growth.
const BACKEND_CACHE_MAX_ENTRIES = 50_000;

const flag = makeFlag($replica);
const backendCache = new BoundedTtlCache<RealtimeBackend>(
  BACKEND_CACHE_TTL_MS,
  BACKEND_CACHE_MAX_ENTRIES
);

export async function resolveRealtimeStreamClient(
  environment: RealtimeEnvironment
): Promise<RealtimeStreamClient> {
  if (!notifierEnabled) {
    return realtimeClient;
  }

  switch (await getRealtimeBackend(environment.organizationId)) {
    case "notifier":
      return getNotifierRealtimeClient();
    case "shadow":
      // Client is still served Electric; the notifier path is diffed in the background.
      return getShadowRealtimeClient();
    case "electric":
    default:
      return realtimeClient;
  }
}

async function getRealtimeBackend(organizationId: string): Promise<RealtimeBackend> {
  const cached = backendCache.get(organizationId);
  if (cached !== undefined) {
    return cached;
  }

  let backend: RealtimeBackend = "electric";

  try {
    const org = await $replica.organization.findFirst({
      where: { id: organizationId },
      select: { featureFlags: true },
    });

    backend = await flag({
      key: FEATURE_FLAG.realtimeBackend,
      defaultValue: "electric",
      overrides: (org?.featureFlags as Record<string, unknown>) ?? {},
    });
  } catch (error) {
    // Never let a flag lookup failure break the realtime feed — fall back to Electric.
    logger.error("[resolveRealtimeStreamClient] failed to resolve realtimeBackend flag", {
      organizationId,
      error,
    });
    backend = "electric";
  }

  backendCache.set(organizationId, backend);
  return backend;
}
