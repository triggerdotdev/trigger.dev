import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { logger } from "../logger.server";
import { type RealtimeEnvironment } from "../realtimeClient.server";
import { realtimeClient } from "../realtimeClientGlobal.server";
import { BoundedTtlCache } from "./boundedTtlCache";
import { type RealtimeStreamClient } from "./nativeRealtimeClient.server";
import { getNativeRealtimeClient } from "./nativeRealtimeClientInstance.server";
import { getShadowRealtimeClient } from "./shadowRealtimeClientInstance.server";

type RealtimeBackend = "electric" | "native" | "shadow";

// Two gates, both defaulting to the Electric path: the env master switch, then the
// per-org `realtimeBackend` feature flag (cached so long-polls don't hit the DB per request).
const nativeBackendEnabled = env.REALTIME_BACKEND_NATIVE_ENABLED === "1";

const flag = singleton("realtimeBackendFlag", () => makeFlag($replica));
const backendCache = singleton(
  "realtimeBackendCache",
  () =>
    new BoundedTtlCache<RealtimeBackend>(
      env.REALTIME_BACKEND_FLAG_CACHE_TTL_MS,
      env.REALTIME_BACKEND_FLAG_CACHE_MAX_ENTRIES
    )
);

export async function resolveRealtimeStreamClient(
  environment: RealtimeEnvironment & { organization?: { featureFlags?: unknown } }
): Promise<RealtimeStreamClient> {
  if (!nativeBackendEnabled) {
    return realtimeClient;
  }

  // The authenticated environment already carries the org's feature flags; pass them
  // through so a cache miss doesn't need an extra organization read.
  const orgFeatureFlags = environment.organization
    ? (environment.organization.featureFlags ?? {})
    : undefined;

  switch (await getRealtimeBackend(environment.organizationId, orgFeatureFlags)) {
    case "native":
      return getNativeRealtimeClient();
    case "shadow":
      // The client is still served Electric; the native path is diffed in the background.
      return getShadowRealtimeClient();
    case "electric":
    default:
      return realtimeClient;
  }
}

async function getRealtimeBackend(
  organizationId: string,
  orgFeatureFlags: unknown | undefined
): Promise<RealtimeBackend> {
  const cached = backendCache.get(organizationId);
  if (cached !== undefined) {
    return cached;
  }

  let backend: RealtimeBackend = "electric";

  try {
    const overrides =
      orgFeatureFlags !== undefined
        ? orgFeatureFlags
        : (
            await $replica.organization.findFirst({
              where: { id: organizationId },
              select: { featureFlags: true },
            })
          )?.featureFlags;

    backend = await flag({
      key: FEATURE_FLAG.realtimeBackend,
      defaultValue: "electric",
      overrides: (overrides as Record<string, unknown>) ?? {},
    });
  } catch (error) {
    // Never let a flag lookup failure break the realtime feed.
    logger.error("[resolveRealtimeStreamClient] failed to resolve realtimeBackend flag", {
      organizationId,
      error,
    });
    backend = "electric";
  }

  backendCache.set(organizationId, backend);
  return backend;
}
