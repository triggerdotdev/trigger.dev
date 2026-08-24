import { createHash } from "node:crypto";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  effectiveMintShardSet,
  GEN_1_PIN_VALUE,
  isValidPinValue,
  readMintShardSetResolution,
  type MintShardSetResolution,
} from "./mintShardGrace";

export type MintShardDeps = {
  // The live list, from the control-plane database.
  resolution: MintShardSetResolution;
  // Fleet-wide pin that beats every per-org and per-env pin. The complete-cutover lever.
  globalOverride?: unknown;
  nowMs: number;
  graceMs: number;
  orgFeatureFlags: unknown;
  onPinRejected?: (info: { environmentId: string; pin: string; activeSet: string[] }) => void;
};

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

// Map keys are environment INTERNAL ids (cuids), not friendly ids. An unparseable blob, or a
// blob whose value for this environment is invalid, yields no per-env pin and lets the
// per-org scalar decide — never a silent un-pin straight to the hash.
function readEnvPin(raw: unknown, environmentId: string): ShardKey | undefined {
  if (typeof raw !== "string") return undefined;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }

  const pins = asRecord(parsed);
  const pin = pins?.[environmentId];
  return isValidPinValue(pin) ? pin : undefined;
}

// Both pins live in the org override blob the trigger path already holds, so resolving a mint
// shard costs no query.
function readPin(orgFeatureFlags: unknown, environmentId: string): ShardKey | undefined {
  const blob = asRecord(orgFeatureFlags);
  if (!blob) return undefined;

  const envPin = readEnvPin(blob[FEATURE_FLAG.runOpsMintShardEnvPins], environmentId);
  if (envPin !== undefined) return envPin;

  const scalar = blob[FEATURE_FLAG.runOpsMintShard];
  return isValidPinValue(scalar) ? scalar : undefined;
}

// 64 bits: a 32-bit score collides at this system's environment count, and an undetected tie
// would resolve by iteration order. The NUL separates the fields so no two input pairs can
// concatenate alike. This hash input is FROZEN once gen-2 minting is live: changing it
// re-places every environment, silently.
function shardScore(environmentId: string, key: string): bigint {
  return createHash("sha256").update(`${environmentId}\0${key}`).digest().readBigUInt64BE(0);
}

function hrwSelect(environmentId: string, activeSet: string[]): string {
  let bestKey = activeSet[0];
  let bestScore = shardScore(environmentId, bestKey);

  for (let i = 1; i < activeSet.length; i++) {
    const key = activeSet[i];
    const score = shardScore(environmentId, key);
    if (score > bestScore || (score === bestScore && key > bestKey)) {
      bestKey = key;
      bestScore = score;
    }
  }

  return bestKey;
}

// PURE CORE — no env, no clock, no I/O; tests drive this directly. Deterministic for fixed
// deps, which is what lets run minting and token minting agree on one answer.
//
// An empty list is the off state, and it is the state of every deployment that has not set the
// flag. Bounding the list against the shard keys this deployment can actually route belongs with
// the shard descriptors, which own that information; nothing here mints, so nothing can misroute.
//
// A pin outside the active set falls through to the hash rather than throwing: honouring it
// would leak the drain the active list performs, and throwing would fail customer triggers
// whenever a pinned shard drains.
export function computeMintShard(environment: { id: string }, deps: MintShardDeps): ShardKey {
  const activeSet = effectiveMintShardSet(deps.resolution, deps.nowMs, deps.graceMs);
  if (activeSet.length === 0) {
    return "new";
  }

  // The global override outranks every pin, so one flag completes a cutover without visiting
  // each org. An override outside the active set is ignored, so explicit pins still apply.
  if (isValidPinValue(deps.globalOverride)) {
    const override = deps.globalOverride;
    if (override === GEN_1_PIN_VALUE) {
      return "new";
    }
    if (activeSet.includes(override)) {
      return override;
    }
    deps.onPinRejected?.({ environmentId: environment.id, pin: override, activeSet });
  }

  const pin = readPin(deps.orgFeatureFlags, environment.id);
  if (pin !== undefined) {
    if (pin === GEN_1_PIN_VALUE) {
      return "new";
    }
    if (activeSet.includes(pin)) {
      return pin;
    }
    deps.onPinRejected?.({ environmentId: environment.id, pin, activeSet });
  }

  return hrwSelect(environment.id, activeSet);
}

// Read together so the override costs no extra query beyond the list it is bounded by.
const GLOBAL_SHARD_KEYS = [
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
  FEATURE_FLAG.runOpsMintShardOverride,
];

type GlobalShardConfig = { resolution: MintShardSetResolution; override: unknown };

export type MintShardCache = { value: GlobalShardConfig; expiresAt: number } | undefined;

export type ResolveMintShardDeps = {
  // Reads the list rows. Injected so the cache and the fail-safe are testable without a
  // database, the same way computeRunIdMintKind takes its flag reader.
  readFlags: () => Promise<Record<string, unknown>>;
  cache: { current: MintShardCache };
  nowMs: number;
  ttlMs: number;
  graceMs: number;
  orgFeatureFlags: unknown;
  onPinRejected?: (info: { environmentId: string; pin: string; activeSet: string[] }) => void;
  onReadFailed?: (error: unknown) => void;
};

// The live list is org-independent, so one process-wide entry serves every mint. One query per
// process per TTL, over one round-trip. The TTL bounds how long two processes can disagree,
// which is what the grace window is sized against.
//
// A failed read falls back to gen-1 rather than guessing a list. Guessing would move every
// environment's placement for the length of one blip.
export async function resolveMintShardWith(
  environment: { id: string; orgFeatureFlags?: unknown },
  deps: ResolveMintShardDeps
): Promise<ShardKey> {
  let config: GlobalShardConfig;
  const cached = deps.cache.current;
  if (cached && cached.expiresAt > deps.nowMs) {
    config = cached.value;
  } else {
    try {
      const flags = await deps.readFlags();
      config = {
        resolution: readMintShardSetResolution(flags),
        override: flags[FEATURE_FLAG.runOpsMintShardOverride],
      };
    } catch (error) {
      deps.onReadFailed?.(error);
      return "new";
    }
    deps.cache.current = { value: config, expiresAt: deps.nowMs + deps.ttlMs };
  }

  return computeMintShard(environment, {
    resolution: config.resolution,
    globalOverride: config.override,
    nowMs: deps.nowMs,
    graceMs: deps.graceMs,
    orgFeatureFlags: deps.orgFeatureFlags,
    onPinRejected: deps.onPinRejected,
  });
}

const liveCache: { current: MintShardCache } = { current: undefined };

async function readSetFlags(): Promise<Record<string, unknown>> {
  const rows = await $replica.featureFlag.findMany({
    where: { key: { in: GLOBAL_SHARD_KEYS } },
    select: { key: true, value: true },
  });
  const flags: Record<string, unknown> = {};
  for (const row of rows) {
    flags[row.key] = row.value;
  }
  return flags;
}

// Once per environment per process: a stale pin sits on the root-trigger path and would
// otherwise log on every trigger for that environment, indefinitely.
const reportedPins = new Set<string>();

function reportPinRejected(info: {
  environmentId: string;
  pin: string;
  activeSet: string[];
}): void {
  if (reportedPins.has(info.environmentId)) return;
  reportedPins.add(info.environmentId);
  logger.error("[runOpsMintShard] pinned shard is not in the active set; using the hash", info);
}

/**
 * Which shard an environment mints new roots into. Call only after resolveRunIdMintKind has
 * returned "runOpsId". Returns "new" to mean a gen-1 run-ops id, which is today's behaviour.
 *
 * @knipignore the gen-2 write-path change is the first production caller; drop this tag there.
 */
export async function resolveMintShard(environment: {
  id: string;
  // Pass environment.organization.featureFlags from the trigger call site.
  orgFeatureFlags?: unknown;
}): Promise<ShardKey> {
  return resolveMintShardWith(environment, {
    readFlags: readSetFlags,
    cache: liveCache,
    nowMs: Date.now(),
    ttlMs: env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS,
    graceMs: env.RUN_OPS_MINT_FLIP_GRACE_MS,
    orgFeatureFlags: environment.orgFeatureFlags,
    onPinRejected: reportPinRejected,
    onReadFailed: (error) =>
      logger.error("[runOpsMintShard] shard-set read failed; minting gen-1 (fail-safe)", { error }),
  });
}
