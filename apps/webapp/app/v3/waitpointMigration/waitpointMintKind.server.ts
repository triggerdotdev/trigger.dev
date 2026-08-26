import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";

/**
 * Which coordinator mints a NEW waitpoint. Consulted at the mint and never again: every
 * later operation routes by id shape. A flip therefore changes only where the NEXT
 * waitpoint is born, which is why this needs no flip-grace machinery.
 */
export type WaitpointMintKind = "legacy" | "store";

/** The flag's vocabulary, deliberately not the coordinator's. */
type WaitpointSystemFlag = "legacy" | "redis";

type MintKindDeps = {
  globalDefault: WaitpointSystemFlag;
  /** Undefined when the org has no override. Must not hit the DB when given org flags. */
  flag: (
    orgId: string,
    orgFeatureFlags: unknown | undefined
  ) => Promise<WaitpointSystemFlag | undefined>;
};

// PURE CORE — no env import; the tests drive this directly.
export async function computeWaitpointMintKind(
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown },
  deps: MintKindDeps
): Promise<WaitpointMintKind> {
  try {
    const perOrg = await deps.flag(environment.organizationId, environment.orgFeatureFlags);
    return (perOrg ?? deps.globalDefault) === "redis" ? "store" : "legacy";
  } catch (error) {
    // Fail safe, as computeRunIdMintKind does: a flag-read failure degrades to the old
    // path rather than becoming a trigger-path outage.
    logger.error("[waitpointMintKind] flag read failed; minting legacy (fail-safe)", { error });
    return "legacy";
  }
}

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
