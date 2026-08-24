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
  parseShardCsv,
  readMintShardSetResolution,
  type MintShardSetResolution,
} from "./mintShardGrace";

export type MintShardDeps = {
  // The live list, from the control-plane database.
  resolution: MintShardSetResolution;
  // The keys this deployment can route, from the environment. Bounds the live list.
  ceiling: string[];
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
// The ceiling gate runs BEFORE the grace, so an unconfigured deployment is an unconditional
// kill switch that no stored value can reopen. The live list is then intersected with the
// ceiling, so a stored key this deployment cannot route is never minted into.
//
// A pin outside the active set falls through to the hash rather than throwing: honouring it
// would leak the drain the active list performs, and throwing would fail customer triggers
// whenever a pinned shard drains.
export function computeMintShard(environment: { id: string }, deps: MintShardDeps): ShardKey {
  if (deps.ceiling.length === 0) {
    return "new";
  }

  const live = effectiveMintShardSet(deps.resolution, deps.nowMs, deps.graceMs);
  const activeSet = live.filter((key) => deps.ceiling.includes(key));
  if (activeSet.length === 0) {
    return "new";
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

// ENV-BOUND wrapper — the only place env is read. The ceiling is parsed once at boot; it is a
// deploy-time value, so re-parsing per mint would burn CPU on the hottest path in the system.
const ceiling: string[] = parseShardCsv(env.RUN_OPS_MINT_SHARDS);

// The live list is org-independent, so one process-wide entry serves every mint. One query per
// process per TTL, folded into a single round-trip over the three keys. The TTL bounds how long
// two processes can disagree, which is what the grace window is sized against.
const SET_KEYS = [
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
];

let cachedResolution: { value: MintShardSetResolution; expiresAt: number } | undefined;

async function readLiveResolution(): Promise<MintShardSetResolution> {
  if (cachedResolution && cachedResolution.expiresAt > Date.now()) {
    return cachedResolution.value;
  }

  const rows = await $replica.featureFlag.findMany({
    where: { key: { in: SET_KEYS } },
    select: { key: true, value: true },
  });
  const flags: Record<string, unknown> = {};
  for (const row of rows) {
    flags[row.key] = row.value;
  }

  const value = readMintShardSetResolution(flags);
  cachedResolution = { value, expiresAt: Date.now() + env.RUN_OPS_MINT_FLAG_CACHE_TTL_MS };
  return value;
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
  // No ceiling means no gen-2 minting, so skip the read entirely.
  if (ceiling.length === 0) {
    return "new";
  }

  let resolution: MintShardSetResolution;
  try {
    resolution = await readLiveResolution();
  } catch (error) {
    // Fail safe to gen-1, mirroring the mint-kind gate's fail-safe to cuid.
    logger.error("[runOpsMintShard] shard-set read failed; minting gen-1 (fail-safe)", { error });
    return "new";
  }

  return computeMintShard(environment, {
    resolution,
    ceiling,
    nowMs: Date.now(),
    graceMs: env.RUN_OPS_MINT_FLIP_GRACE_MS,
    orgFeatureFlags: environment.orgFeatureFlags,
    onPinRejected: reportPinRejected,
  });
}
