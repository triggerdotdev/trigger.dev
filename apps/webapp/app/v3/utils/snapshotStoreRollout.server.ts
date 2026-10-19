import type { PrismaClient } from "@trigger.dev/database";
import type { SnapshotStoreDial } from "@internal/run-store";
import { FEATURE_FLAG, FeatureFlagCatalog } from "../featureFlags";

export type SnapshotRolloutFlags = { snapshotStoreMode?: SnapshotStoreDial };

const DIAL_CACHE_MAX_ENTRIES = 10_000;

/**
 * Use the normal org flag, falling back to the already-polled global default.
 * Fetched org overrides are cached in memory per organization for `dialCacheMs` (absent or 0
 * disables), so a flag flip takes up to that long to apply.
 */
export function createSnapshotRolloutResolver(
  readFlags: () => SnapshotRolloutFlags | undefined,
  prisma: Pick<PrismaClient, "organization">,
  options?: { dialCacheMs?: number }
) {
  const ttlMs = options?.dialCacheMs ?? 0;
  // Insertion-ordered, so the first key is the oldest entry for FIFO eviction.
  const overridesCache = new Map<string, { overrides: unknown; fetchedAt: number }>();

  async function fetchOverrides(organizationId: string): Promise<unknown> {
    if (ttlMs > 0) {
      const cached = overridesCache.get(organizationId);
      if (cached) {
        if (Date.now() - cached.fetchedAt < ttlMs) return cached.overrides;
        overridesCache.delete(organizationId);
      }
    }
    const overrides = (
      await prisma.organization.findFirst({
        where: { id: organizationId },
        select: { featureFlags: true },
      })
    )?.featureFlags;
    if (ttlMs > 0) {
      overridesCache.delete(organizationId);
      if (overridesCache.size >= DIAL_CACHE_MAX_ENTRIES) {
        const oldest = overridesCache.keys().next().value;
        if (oldest !== undefined) overridesCache.delete(oldest);
      }
      overridesCache.set(organizationId, { overrides, fetchedAt: Date.now() });
    }
    return overrides;
  }

  return {
    async resolveDial(
      organizationId: string,
      organizationFlags?: unknown
    ): Promise<SnapshotStoreDial> {
      // undefined means not loaded; null/{} means loaded with no override. Do not refetch those.
      const overrides =
        organizationFlags === undefined ? await fetchOverrides(organizationId) : organizationFlags;
      const value =
        typeof overrides === "object" && overrides !== null && "snapshotStoreMode" in overrides
          ? overrides.snapshotStoreMode
          : undefined;
      if (value !== undefined) {
        const parsed = FeatureFlagCatalog[FEATURE_FLAG.snapshotStoreMode].safeParse(value);
        if (parsed.success) return parsed.data;
      }
      return readFlags()?.snapshotStoreMode ?? "off";
    },
  };
}
