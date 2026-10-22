import type { PrismaClient } from "@trigger.dev/database";
import { FEATURE_FLAG, FeatureFlagCatalog } from "../featureFlags";

/** The normal organization override, then global default, then off. No rollout history. */
export function createWaitpointStoreEnabledResolver(
  readFlags: () => { waitpointStoreEnabled?: boolean } | undefined,
  prisma: Pick<PrismaClient, "organization">
) {
  return async (organizationId: string, organizationFlags?: unknown): Promise<boolean> => {
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
      typeof overrides === "object" && overrides !== null && "waitpointStoreEnabled" in overrides
        ? overrides.waitpointStoreEnabled
        : undefined;
    const parsed = FeatureFlagCatalog[FEATURE_FLAG.waitpointStoreEnabled].safeParse(value);
    return parsed.success ? parsed.data : (readFlags()?.waitpointStoreEnabled ?? false);
  };
}
