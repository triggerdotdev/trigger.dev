import type { RunIdMintKind } from "./runOpsMintKind.server";

export type { RunIdMintKind };

export type MintFlagResolution = {
  kind: RunIdMintKind;
  prev?: RunIdMintKind;
  flippedAtMs?: number;
};

const DEFAULT_MINT_KIND: RunIdMintKind = "cuid";

// Deterministic wall-clock cutover: during [flippedAt, flippedAt + graceMs) every
// process — stale (hasn't re-read the flag) or fresh (has the new stamp) — resolves to
// the OLD kind. At/after the cutover, every process resolves to the NEW kind.
export function effectiveMintKind(
  r: MintFlagResolution,
  nowMs: number,
  graceMs: number
): RunIdMintKind {
  if (r.prev === undefined || r.flippedAtMs === undefined) {
    return r.kind;
  }
  return nowMs < r.flippedAtMs + graceMs ? r.prev : r.kind;
}

function readMintKind(flags: Record<string, unknown>, key: string): RunIdMintKind | undefined {
  const value = flags[key];
  return value === "cuid" || value === "runOpsId" ? value : undefined;
}

function resolveEffectiveFromFlags(
  flags: Record<string, unknown> | null | undefined,
  nowMs: number,
  graceMs: number
): RunIdMintKind {
  const source = flags ?? {};
  const kind = readMintKind(source, "runOpsMintKind") ?? DEFAULT_MINT_KIND;
  const prev = readMintKind(source, "runOpsMintKindPrev");
  const flippedAtRaw = source.runOpsMintKindFlippedAt;
  const parsed = typeof flippedAtRaw === "string" ? Date.parse(flippedAtRaw) : NaN;
  const flippedAtMs = Number.isNaN(parsed) ? undefined : parsed;

  return effectiveMintKind({ kind, prev, flippedAtMs }, nowMs, graceMs);
}

// Stamps a grace window only when the outgoing TARGET kind differs from the stored one (a
// genuine flip); prev := the currently-effective kind. A save that leaves the target kind
// unchanged carries any in-flight stamp forward, so it can't reset the cutover clock.
export function stampMintKindFlip(
  existingFlags: Record<string, unknown> | null | undefined,
  outgoingFlags: Record<string, unknown>,
  nowMs: number,
  graceMs: number
): Record<string, unknown> {
  const storedKind = readMintKind(existingFlags ?? {}, "runOpsMintKind") ?? DEFAULT_MINT_KIND;
  const outgoingKind = readMintKind(outgoingFlags, "runOpsMintKind") ?? DEFAULT_MINT_KIND;
  outgoingFlags.runOpsMintKind = outgoingKind;

  if (outgoingKind !== storedKind) {
    // Genuine target change: serve the currently-effective kind through the new grace window.
    outgoingFlags.runOpsMintKindPrev = resolveEffectiveFromFlags(existingFlags, nowMs, graceMs);
    outgoingFlags.runOpsMintKindFlippedAt = new Date(nowMs).toISOString();
    return outgoingFlags;
  }

  const existing = existingFlags ?? {};
  const existingPrev = existing.runOpsMintKindPrev;
  const existingFlippedAt = existing.runOpsMintKindFlippedAt;
  if (existingPrev !== undefined) {
    outgoingFlags.runOpsMintKindPrev = existingPrev;
  }
  if (existingFlippedAt !== undefined) {
    outgoingFlags.runOpsMintKindFlippedAt = existingFlippedAt;
  }
  return outgoingFlags;
}
