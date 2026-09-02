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

// Flag keys holding the active set and its grace stamp. Named here so the pure module can read
// a flag record without importing the catalog.
const SET_KEY = "runOpsMintShardSet";
const SET_PREV_KEY = "runOpsMintShardSetPrev";
const SET_FLIPPED_AT_KEY = "runOpsMintShardSetFlippedAt";

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

/** Reports a stored value that could not be parsed. The module stays pure; the caller logs. */
export type MintShardSetParseFailure = { key: string; value: string; error: unknown };

// The active set lives in the control-plane database, not in the environment. A deploy rolls
// for hours, so two pods can hold different environment values at the same time; only a shared
// row lets every pod agree on one set. Boot may reject a bad environment value, but the mint
// path must never throw on a bad stored value, so an unreadable list degrades to empty.
//
// Degrading is right; degrading SILENTLY is not. An unparseable value (a `"A,B"` typed in
// uppercase) reverts the whole fleet to gen-1 minting, so the failure is reported to the caller,
// which owns the logger. The reserved-key and alphabet rejections are the same failure.
export type OnInvalidShardSet = (failure: MintShardSetParseFailure) => void;

function readStoredCsv(value: unknown, key: string, onInvalid?: OnInvalidShardSet): string[] {
  if (typeof value !== "string") return [];
  try {
    return parseShardCsv(value);
  } catch (error) {
    onInvalid?.({ key, value, error });
    return [];
  }
}

// Reads the { set, prevSet, flippedAtMs } trio out of one flag record. Pure. A prevSet with no
// timestamp can never apply, so it is dropped. A timestamp with an EMPTY prevSet is meaningful:
// it graces a first activation, serving no shards for the window.
export function readMintShardSetResolution(
  flags: Record<string, unknown> | null | undefined,
  onInvalid?: OnInvalidShardSet
): MintShardSetResolution {
  const source = flags ?? {};
  const flippedAtRaw = source[SET_FLIPPED_AT_KEY];
  const parsed = typeof flippedAtRaw === "string" ? Date.parse(flippedAtRaw) : NaN;
  const flippedAtMs = Number.isNaN(parsed) ? undefined : parsed;

  return {
    set: readStoredCsv(source[SET_KEY], SET_KEY, onInvalid),
    prevSet:
      flippedAtMs === undefined
        ? undefined
        : readStoredCsv(source[SET_PREV_KEY], SET_PREV_KEY, onInvalid),
    flippedAtMs,
  };
}

// Stamps a grace window only when the outgoing set differs from the stored one. prev becomes the
// set readers serve right now, so a second flip inside one window cannot strand the first. A save
// that leaves the set unchanged carries any in-flight stamp forward, so it cannot reset the clock.
export function stampMintShardSetFlip(
  existingFlags: Record<string, unknown> | null | undefined,
  outgoingFlags: Record<string, unknown>,
  nowMs: number,
  graceMs: number,
  onInvalid?: OnInvalidShardSet
): Record<string, unknown> {
  // Only act when the save actually SETS the list. Omitting it must not inject a default.
  if (typeof outgoingFlags[SET_KEY] !== "string") {
    return outgoingFlags;
  }

  const existing = existingFlags ?? {};
  const outgoingSet = readStoredCsv(outgoingFlags[SET_KEY], SET_KEY, onInvalid);
  const storedSet = readStoredCsv(existing[SET_KEY], SET_KEY, onInvalid);

  if (outgoingSet.join(",") !== storedSet.join(",")) {
    const effective = effectiveMintShardSet(
      readMintShardSetResolution(existing, onInvalid),
      nowMs,
      graceMs
    );
    outgoingFlags[SET_PREV_KEY] = effective.join(",");
    outgoingFlags[SET_FLIPPED_AT_KEY] = new Date(nowMs).toISOString();
    return outgoingFlags;
  }

  if (existing[SET_PREV_KEY] !== undefined) {
    outgoingFlags[SET_PREV_KEY] = existing[SET_PREV_KEY];
  }
  if (existing[SET_FLIPPED_AT_KEY] !== undefined) {
    outgoingFlags[SET_FLIPPED_AT_KEY] = existing[SET_FLIPPED_AT_KEY];
  }
  return outgoingFlags;
}
