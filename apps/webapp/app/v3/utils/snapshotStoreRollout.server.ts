import type { PrismaClient } from "@trigger.dev/database";
import type { SnapshotStoreDial } from "@internal/run-store";
import { FEATURE_FLAG, FeatureFlagCatalog } from "../featureFlags";

export type SnapshotRolloutFlags = { snapshotStoreMode?: SnapshotStoreDial };

/** Use the normal org flag, falling back to the already-polled global default. No org cache. */
export function createSnapshotRolloutResolver(
  readFlags: () => SnapshotRolloutFlags | undefined,
  prisma: Pick<PrismaClient, "organization">
) {
  return {
    async resolveDial(
      organizationId: string,
      organizationFlags?: unknown
    ): Promise<SnapshotStoreDial> {
      // undefined means not loaded; null/{} means loaded with no override. Do not refetch those.
      const overrides =
        organizationFlags === undefined
          ? (
              await prisma.organization.findFirst({
                where: { id: organizationId },
                select: { featureFlags: true },
              })
            )?.featureFlags
          : organizationFlags;
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
