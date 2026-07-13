import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { DEFAULT_CP_CACHE_TTL_MS } from "./controlPlaneCache.server";
import { effectiveMintKind, resolveMintFlag, type MintFlagResolution } from "./mintFlipGrace";
import { isSplitEnabled } from "./splitMode.server";

export type RunIdMintKind = "cuid" | "runOpsId";

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
const mintCache = singleton(
  "runOpsMintCache",
  () =>
    new BoundedTtlCache<MintFlagResolution>(
      env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS,
      env.RUN_OPS_MINT_FLAG_CACHE_MAX_ENTRIES
    )
);

// BOOT-TIME SAFETY CHECK (warning only, never throws): the grace window only collapses
// the cross-process divergence window if it outlasts BOTH caches a flag flip has to drain
// through — this process's own mint-flag cache AND the org-flags control-plane cache a
// stale process might still be reading through. If it doesn't, warn loudly but keep booting.
const controlPlaneCacheTtlMs = env.CONTROL_PLANE_CACHE_TTL_MS ?? DEFAULT_CP_CACHE_TTL_MS;
if (env.RUN_OPS_MINT_FLIP_GRACE_MS <= env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS + controlPlaneCacheTtlMs) {
  logger.warn(
    "[runOpsMintKind] RUN_OPS_MINT_FLIP_GRACE_MS does not exceed the sum of " +
      "RUN_OPS_MINT_FLAG_CACHE_TTL_MS and the control-plane cache TTL; a flag flip can still " +
      "cross-DB-duplicate a concurrent root trigger during the divergence window",
    {
      RUN_OPS_MINT_FLIP_GRACE_MS: env.RUN_OPS_MINT_FLIP_GRACE_MS,
      RUN_OPS_MINT_FLAG_CACHE_TTL_MS: env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS,
      controlPlaneCacheTtlMs,
    }
  );
}

export async function resolveRunIdMintKind(environment: {
  organizationId: string;
  id: string;
  // Pass environment.organization.featureFlags from the trigger call site.
  orgFeatureFlags?: unknown;
}): Promise<RunIdMintKind> {
  return computeRunIdMintKind(environment, {
    masterEnabled: env.RUN_OPS_MINT_ENABLED,
    splitEnabled: isSplitEnabled,
    flag: async (orgId, orgFeatureFlags) => {
      // The cache stores the full { kind, prev, flippedAtMs } trio (never undefined), so the
      // cache's "stored-undefined == miss" caveat never applies here. A cache HIT still passes
      // back through effectiveMintKind so a cached-but-stale entry crosses the grace boundary
      // on schedule, without needing an invalidation hook.
      const cached = mintCache.get(orgId);
      if (cached !== undefined) {
        return effectiveMintKind(cached, Date.now(), env.RUN_OPS_MINT_FLIP_GRACE_MS);
      }

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

      const overridesRecord = (overrides as Record<string, unknown>) ?? {};

      // One global read over the three mint-flag keys (kind + grace stamp), folded into the
      // single cache-miss round-trip. This replaces the former single-key flag read, so a
      // GLOBAL flip is now grace-stamped WITHOUT adding any new per-mint/per-resolve query.
      // (The cache-hit branch above never touches the DB.)
      const globalRows = await $replica.featureFlag.findMany({
        where: {
          key: {
            in: [
              FEATURE_FLAG.runOpsMintKind,
              FEATURE_FLAG.runOpsMintKindPrev,
              FEATURE_FLAG.runOpsMintKindFlippedAt,
            ],
          },
        },
        select: { key: true, value: true },
      });
      const globalFlags: Record<string, unknown> = {};
      for (const row of globalRows) {
        globalFlags[row.key] = row.value;
      }

      // Source-consistent: a per-org override wins the kind AND its stamp; otherwise the
      // global row wins the kind AND its stamp.
      const resolution: MintFlagResolution = resolveMintFlag(overridesRecord, globalFlags);
      mintCache.set(orgId, resolution);
      return effectiveMintKind(resolution, Date.now(), env.RUN_OPS_MINT_FLIP_GRACE_MS);
    },
  });
}
