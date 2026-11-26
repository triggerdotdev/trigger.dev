import type { PrismaClient } from "@trigger.dev/database";
import { FEATURE_FLAG, FeatureFlagCatalog } from "../featureFlags";

/** The normal organization override, then global default, then off. Read once per suspend. */
export function createCheckpointStoreEnabledResolver(
  readFlags: () => { checkpointStoreEnabled?: boolean } | undefined,
  prisma: Pick<PrismaClient, "organization">
) {
  return async (organizationId: string): Promise<boolean> => {
    const overrides = (
      await prisma.organization.findFirst({
        where: { id: organizationId },
        select: { featureFlags: true },
      })
    )?.featureFlags;
    const value =
      typeof overrides === "object" && overrides !== null && "checkpointStoreEnabled" in overrides
        ? overrides.checkpointStoreEnabled
        : undefined;
    const parsed = FeatureFlagCatalog[FEATURE_FLAG.checkpointStoreEnabled].safeParse(value);
    return parsed.success ? parsed.data : (readFlags()?.checkpointStoreEnabled ?? false);
  };
}
