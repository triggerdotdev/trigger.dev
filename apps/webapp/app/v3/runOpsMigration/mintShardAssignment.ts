// PURE module: no env, no clock, no database. Kept separate from the .server wrapper so a test
// can drive it without evaluating env.server, whose schema parse demands a full environment.
import { createHash } from "node:crypto";
import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import {
  effectiveMintShardSet,
  GEN_1_PIN_VALUE,
  isValidPinValue,
  readMintShardSetResolution,
  type MintShardSetParseFailure,
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
  // The shard keys this deployment can actually route (the RUN_OPS_SHARDS descriptor keys). The
  // active set is bounded to these, so a stored key with no descriptor is never minted into.
  // Undefined means "no bound" (today's behaviour).
  routableKeys?: readonly string[];
  onPinRejected?: (info: { environmentId: string; pin: string; activeSet: string[] }) => void;
  onOverrideRejected?: (info: { override: string; activeSet: string[] }) => void;
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
  const rawActiveSet = effectiveMintShardSet(deps.resolution, deps.nowMs, deps.graceMs);
  // Empty check BEFORE the bound, so an unconfigured deployment returns "new" exactly as today.
  if (rawActiveSet.length === 0) {
    return "new";
  }

  // Bound the active set to the keys this deployment can route. A stored key with no descriptor is
  // dropped, never minted into. If nothing survives, fall back to gen-1 (fail-safe, never a throw).
  const activeSet = deps.routableKeys
    ? rawActiveSet.filter((key) => deps.routableKeys!.includes(key))
    : rawActiveSet;
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
    // Fleet-wide, so it is reported once for the value, not once per environment.
    deps.onOverrideRejected?.({ override, activeSet });
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

type GlobalShardConfig = { resolution: MintShardSetResolution; override: unknown };

export type MintShardCache = { value: GlobalShardConfig; expiresAt: number } | undefined;

type MintShardCacheHandle = {
  current: MintShardCache;
  // The refresh currently in flight, if any. Concurrent misses share it.
  inFlight?: Promise<GlobalShardConfig>;
};

export type ResolveMintShardDeps = {
  // Reads the list rows. Injected so the cache and the fail-safe are testable without a
  // database, the same way computeRunIdMintKind takes its flag reader.
  readFlags: () => Promise<Record<string, unknown>>;
  cache: MintShardCacheHandle;
  nowMs: number;
  ttlMs: number;
  graceMs: number;
  orgFeatureFlags: unknown;
  routableKeys?: readonly string[];
  onPinRejected?: (info: { environmentId: string; pin: string; activeSet: string[] }) => void;
  onOverrideRejected?: (info: { override: string; activeSet: string[] }) => void;
  onReadFailed?: (error: unknown) => void;
  // A stored set that PARSED badly, which is not a read failure: onReadFailed never fires for it,
  // yet the fleet reverts to gen-1 minting. Reported here so the operator sees the degrade.
  onSetParseFailed?: (failure: MintShardSetParseFailure) => void;
};

// The live list is org-independent, so one process-wide entry serves every mint: one query per
// process per TTL, over one round-trip. Two processes can therefore disagree for the TTL PLUS the
// replica lag behind the read, which can exceed graceMs. That is tolerable here and only here,
// because a gen-2 id carries its own shard key, so disagreement cannot misroute an existing run;
// it only decides where the next root lands, and every failure direction is toward gen-1.
//
// A failed read falls back to gen-1 rather than guessing a list. Guessing would move every
// environment's placement for the length of one blip.
async function refreshConfig(deps: ResolveMintShardDeps): Promise<GlobalShardConfig> {
  try {
    const flags = await deps.readFlags();
    const config: GlobalShardConfig = {
      resolution: readMintShardSetResolution(flags, deps.onSetParseFailed),
      override: flags[FEATURE_FLAG.runOpsMintShardOverride],
    };
    deps.cache.current = { value: config, expiresAt: deps.nowMs + deps.ttlMs };
    return config;
  } finally {
    deps.cache.inFlight = undefined;
  }
}

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
      // Single-flight. Without it, two misses both read, and a slower read landing after a
      // faster one puts its older snapshot back into the cache for a whole TTL.
      config = await (deps.cache.inFlight ??= refreshConfig(deps));
    } catch (error) {
      deps.onReadFailed?.(error);
      return "new";
    }
  }

  return computeMintShard(environment, {
    resolution: config.resolution,
    globalOverride: config.override,
    nowMs: deps.nowMs,
    graceMs: deps.graceMs,
    orgFeatureFlags: deps.orgFeatureFlags,
    routableKeys: deps.routableKeys,
    onPinRejected: deps.onPinRejected,
    onOverrideRejected: deps.onOverrideRejected,
  });
}
