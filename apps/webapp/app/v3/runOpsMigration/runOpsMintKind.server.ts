import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { isSplitEnabled } from "./splitMode.server";

export type RunIdMintKind = "cuid" | "ksuid";

type MintKindDeps = {
  masterEnabled: boolean;
  splitEnabled: () => Promise<boolean>;
  // Receives the orgId + the (optional) already-loaded org feature flags. When
  // orgFeatureFlags is provided, the implementation must NOT read the DB for them.
  flag: (orgId: string, orgFeatureFlags: unknown | undefined) => Promise<RunIdMintKind>;
};

// PURE CORE — no env import; tests drive this directly. Gate order is load-bearing:
// master switch → split gate → per-org flag, short-circuiting at the first OFF.
export async function computeRunIdMintKind(
  environment: { organizationId: string; id: string; orgFeatureFlags?: unknown },
  deps: MintKindDeps
): Promise<RunIdMintKind> {
  if (!deps.masterEnabled) return "cuid";
  if (!(await deps.splitEnabled())) return "cuid";
  try {
    return await deps.flag(environment.organizationId, environment.orgFeatureFlags);
  } catch (error) {
    logger.error("[runOpsMintKind] flag read failed; minting cuid (fail-safe)", { error });
    return "cuid";
  }
}

// ENV-BOUND wrapper — the only place env/$replica/isSplitEnabled are read.
const flagFn = singleton("runOpsMintFlag", () => makeFlag($replica));
const mintCache = singleton(
  "runOpsMintCache",
  () =>
    new BoundedTtlCache<RunIdMintKind>(
      env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS,
      env.RUN_OPS_MINT_FLAG_CACHE_MAX_ENTRIES
    )
);

export async function resolveRunIdMintKind(environment: {
  organizationId: string;
  id: string;
  // Pass environment.organization.featureFlags from the trigger call site.
  orgFeatureFlags?: unknown;
}): Promise<RunIdMintKind> {
  return computeRunIdMintKind(environment, {
    masterEnabled: env.RUN_OPS_MINT_KSUID_ENABLED,
    splitEnabled: isSplitEnabled,
    flag: async (orgId, orgFeatureFlags) => {
      // The cache stores only "cuid"|"ksuid" (never undefined), so the cache's
      // "stored-undefined == miss" caveat never applies here.
      const cached = mintCache.get(orgId);
      if (cached !== undefined) return cached;

      // Hot-path pass-through: use the org flags the authenticated environment already
      // carries; only fall back to a DB read when the caller did NOT pass them (non-trigger
      // callers). The trigger path always passes them, so it never issues this findFirst.
      const overrides =
        orgFeatureFlags !== undefined
          ? orgFeatureFlags
          : (
              await $replica.organization.findFirst({
                where: { id: orgId },
                select: { featureFlags: true },
              })
            )?.featureFlags;

      const kind = await flagFn({
        key: FEATURE_FLAG.runOpsMintKsuid,
        defaultValue: "cuid",
        overrides: (overrides as Record<string, unknown>) ?? {},
      });
      mintCache.set(orgId, kind);
      return kind;
    },
  });
}
