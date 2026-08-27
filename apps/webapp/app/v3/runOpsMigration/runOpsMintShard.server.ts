import { $replica, boundedIn } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { BoundedTtlCache } from "~/services/realtime/boundedTtlCache";
import { singleton } from "~/utils/singleton";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { resolveMintShardWith, type MintShardCache } from "./mintShardAssignment";

// A misconfiguration is reported again after this long, so a still-broken pin stays visible
// without logging on every trigger.
const REPORT_TTL_MS = 3_600_000;
const REPORT_MAX_ENTRIES = 10_000;

const GLOBAL_SHARD_KEYS = [
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
  FEATURE_FLAG.runOpsMintShardOverride,
];

const liveCache = singleton("runOpsMintShardCache", (): { current: MintShardCache } => ({
  current: undefined,
}));

async function readSetFlags(): Promise<Record<string, unknown>> {
  const rows = await $replica.featureFlag.findMany({
    where: { key: { in: boundedIn(GLOBAL_SHARD_KEYS) } },
    select: { key: true, value: true },
  });
  const flags: Record<string, unknown> = {};
  for (const row of rows) {
    flags[row.key] = row.value;
  }
  return flags;
}

// A stale pin sits on the root-trigger path, so it would otherwise log on every trigger for that
// environment forever. Bounded, because the set of pinned environments is operator-controlled but
// not operator-bounded, and an unbounded Set on this path is a leak.
const reportedPins = singleton(
  "runOpsMintShardReportedPins",
  () => new BoundedTtlCache<true>(REPORT_TTL_MS, REPORT_MAX_ENTRIES)
);

function reportPinRejected(info: {
  environmentId: string;
  pin: string;
  activeSet: string[];
}): void {
  if (reportedPins.get(info.environmentId) !== undefined) return;
  reportedPins.set(info.environmentId, true);
  logger.error("[runOpsMintShard] pinned shard is not in the active set; using the hash", info);
}

// Keyed by the override value, not by environment: one bad override applies to the whole fleet,
// so one line is the correct volume. Keying by environment would log once per environment.
const reportedOverrides = singleton(
  "runOpsMintShardReportedOverrides",
  () => new BoundedTtlCache<true>(REPORT_TTL_MS, REPORT_MAX_ENTRIES)
);

function reportOverrideRejected(info: { override: string; activeSet: string[] }): void {
  if (reportedOverrides.get(info.override) !== undefined) return;
  reportedOverrides.set(info.override, true);
  logger.error("[runOpsMintShard] override shard is not in the active set; ignoring it", info);
}

/**
 * Which shard an environment mints new roots into. Call only after resolveRunIdMintKind has
 * returned "runOpsId". Returns "new" to mean a gen-1 run-ops id, which is today's behaviour.
 */
export async function resolveMintShard(environment: {
  id: string;
  // Pass environment.organization.featureFlags from the trigger call site.
  orgFeatureFlags?: unknown;
}): Promise<ShardKey> {
  // Answer before reading anything, so an unconfigured deployment adds no control-plane query to
  // the trigger path, no cache write and no log line.
  if (env.RUN_OPS_SHARDS.length === 0) {
    return "new";
  }

  return resolveMintShardWith(environment, {
    readFlags: readSetFlags,
    cache: liveCache,
    nowMs: Date.now(),
    ttlMs: env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS,
    graceMs: env.RUN_OPS_MINT_FLIP_GRACE_MS,
    orgFeatureFlags: environment.orgFeatureFlags,
    // Bound the active list to the shards this deployment can actually route.
    routableKeys: env.RUN_OPS_SHARDS.map((shard) => shard.key),
    onPinRejected: reportPinRejected,
    onOverrideRejected: reportOverrideRejected,
    onReadFailed: (error) =>
      logger.error("[runOpsMintShard] shard-set read failed; minting gen-1 (fail-safe)", { error }),
  });
}
