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

/**
 * Whether new standalone wait tokens may go to the waitpoint store (the store flag must be on as
 * well): the organization override from its loaded flags, then the global value, then off. No query.
 */
export function waitpointStoreStandaloneTokensEnabled(
  organizationFlags: unknown,
  globalFlags: { waitpointStoreStandaloneTokens?: boolean } | undefined
): boolean {
  const value =
    typeof organizationFlags === "object" &&
    organizationFlags !== null &&
    FEATURE_FLAG.waitpointStoreStandaloneTokens in organizationFlags
      ? (organizationFlags as Record<string, unknown>)[FEATURE_FLAG.waitpointStoreStandaloneTokens]
      : undefined;
  const parsed = FeatureFlagCatalog[FEATURE_FLAG.waitpointStoreStandaloneTokens].safeParse(value);
  return parsed.success ? parsed.data : (globalFlags?.waitpointStoreStandaloneTokens ?? false);
}
