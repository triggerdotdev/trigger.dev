import type { ShardKey } from "@trigger.dev/core/v3/isomorphic";

// Index 24 of a gen-2 id sits inside the pod name `runner-<id>`, and a DNS-1123 label accepts
// lowercase only, so the alphabet is 36 keys and no wider. Core keeps its copy private;
// mintShardGrace.test.ts pins this pattern to generateRunOpsIdV2 instead.
export const SHARD_KEY_PATTERN = /^[a-z0-9]$/;

// Neither may enter the active set: "new" already means "mint a gen-1 run-ops id" and
// "legacy" means the cuid store, which minting never selects.
const RESERVED_SHARD_KEYS: readonly string[] = ["new", "legacy"];

// "new" IS legal as a PIN, holding one org or environment on gen-1 while the rest of the fleet
// mints gen-2. Without it a non-empty active set moves every environment at once.
export const GEN_1_PIN_VALUE = "new";

export type MintShardSetResolution = {
  set: string[];
  prevSet?: string[];
  flippedAtMs?: number;
};

export function isValidPinValue(value: unknown): value is ShardKey {
  if (typeof value !== "string") return false;
  return value === GEN_1_PIN_VALUE || SHARD_KEY_PATTERN.test(value);
}

// Throws rather than dropping a bad key: generateRunOpsIdV2 throws on an out-of-alphabet char,
// so an unvalidated key must fail at boot and never at mint.
export function parseShardCsv(raw: string | undefined | null): string[] {
  const keys = (raw ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  const unique = new Set<string>();
  for (const key of keys) {
    if (RESERVED_SHARD_KEYS.includes(key)) {
      throw new Error(`"${key}" is a reserved key and cannot be an active mint shard`);
    }
    if (!SHARD_KEY_PATTERN.test(key)) {
      throw new Error(`invalid shard key "${key}": must be a single char in [a-z0-9]`);
    }
    unique.add(key);
  }

  // Sorted so no placement can depend on the order an operator typed the CSV in.
  return [...unique].sort();
}

// Cutover boundary, mirroring effectiveMintKind. `nowMs` is the reader's wall clock while
// `flippedAtMs` is operator-supplied, so this assumes NTP-synced hosts with skew << graceMs,
// letting every process cross [flippedAtMs, flippedAtMs + graceMs) together (OLD then NEW).
export function effectiveMintShardSet(
  r: MintShardSetResolution,
  nowMs: number,
  graceMs: number
): string[] {
  if (r.prevSet === undefined || r.flippedAtMs === undefined) {
    return r.set;
  }
  return nowMs < r.flippedAtMs + graceMs ? r.prevSet : r.set;
}

// A prevSet with no timestamp can never apply, so it is dropped. A timestamp with an EMPTY
// prevSet is meaningful: it graces a first activation, serving no shards for the window.
export function buildMintShardResolution(source: {
  shards: string | undefined;
  prev: string | undefined;
  flippedAt: string | undefined;
}): MintShardSetResolution {
  const parsed = source.flippedAt !== undefined ? Date.parse(source.flippedAt) : NaN;
  const flippedAtMs = Number.isNaN(parsed) ? undefined : parsed;

  return {
    set: parseShardCsv(source.shards),
    prevSet: flippedAtMs === undefined ? undefined : parseShardCsv(source.prev),
    flippedAtMs,
  };
}

// Returns a message to log when the stamp is half-configured, otherwise undefined. Stays quiet
// while the active set is empty, so an unconfigured deployment logs nothing at boot.
export function mintShardStampWarning(source: {
  shards: string | undefined;
  prev: string | undefined;
  flippedAt: string | undefined;
}): string | undefined {
  if (parseShardCsv(source.shards).length === 0) {
    return undefined;
  }
  if (parseShardCsv(source.prev).length > 0 && source.flippedAt === undefined) {
    return "RUN_OPS_MINT_SHARDS_PREV is set but RUN_OPS_MINT_SHARDS_FLIPPED_AT is not; the shard-set grace window will never apply";
  }
  return undefined;
}
