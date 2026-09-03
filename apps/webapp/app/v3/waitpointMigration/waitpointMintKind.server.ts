import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { computeWaitpointMintKind, type WaitpointMintKind } from "./waitpointMintKind.js";

export type { WaitpointMintKind };

// The two unions are declared separately, because the engine never imports from the
// webapp. Nothing pins them together here on purpose: every call site passes this value
// into an engine method, so a drift fails at those call sites, where the error is local
// to the code that actually broke.

type WaitpointSystemFlag = "legacy" | "redis";

const mintCache = singleton(
  "waitpointMintCache",
  () =>
    new BoundedTtlCache<WaitpointSystemFlag | null>(
      env.WAITPOINT_MINT_FLAG_CACHE_TTL_MS,
      env.WAITPOINT_MINT_FLAG_CACHE_MAX_ENTRIES
    )
);

// ENV-BOUND wrapper — the only place env and $replica are read.
export async function resolveWaitpointMintKind(environment: {
  organizationId: string;
  id: string;
  /** Pass environment.organization.featureFlags from the call site. */
  orgFeatureFlags?: unknown;
}): Promise<WaitpointMintKind> {
  return computeWaitpointMintKind(environment, {
    globalDefault: env.WAITPOINT_SYSTEM_DEFAULT,
    onError: (error) =>
      logger.error("[waitpointMintKind] flag read failed; minting legacy (fail-safe)", { error }),
    flag: async (orgId, orgFeatureFlags) => {
      // null is a cached "this org has no override", which must stay distinct from a miss:
      // BoundedTtlCache reports a stored undefined as a miss, so never store undefined.
      const cached = mintCache.get(orgId);
      if (cached !== undefined) {
        return cached ?? undefined;
      }

      // Hot-path pass-through: only read the replica when the caller passed no org flags.
      const overrides =
        orgFeatureFlags !== undefined
          ? orgFeatureFlags
          : (
              await $replica.organization.findFirst({
                where: { id: orgId },
                select: { featureFlags: true },
              })
            )?.featureFlags;

      const value = (overrides as Record<string, unknown> | null | undefined)?.[
        FEATURE_FLAG.waitpointSystem
      ];
      const resolved = value === "redis" || value === "legacy" ? value : null;

      mintCache.set(orgId, resolved);
      return resolved ?? undefined;
    },
  });
}
