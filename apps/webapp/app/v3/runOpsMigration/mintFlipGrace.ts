import type { RunIdMintKind } from "./runOpsMintKind.server";

export type { RunIdMintKind };

export type MintFlagResolution = {
  kind: RunIdMintKind;
  prev?: RunIdMintKind;
  flippedAtMs?: number;
};

const DEFAULT_MINT_KIND: RunIdMintKind = "cuid";

// Cutover boundary. `nowMs` is the reader's wall clock but `flippedAtMs` (in `r`) is DB-clock
// (admin routes) — so this assumes NTP-synced hosts with skew << graceMs, letting every process
// cross [flippedAtMs, flippedAtMs + graceMs) together (OLD then NEW). Accepted residual: a badly
// mis-synced host can cross early/late and briefly reopen a skew-wide cross-DB duplicate window.
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

// Reads the { kind, prev, flippedAtMs } trio out of one flag record — either an org's
// featureFlags override blob or the global FeatureFlag rows projected into a record. Pure.
export function readMintResolution(
  flags: Record<string, unknown> | null | undefined
): MintFlagResolution {
  const source = flags ?? {};
  const kind = readMintKind(source, "runOpsMintKind") ?? DEFAULT_MINT_KIND;
  const prev = readMintKind(source, "runOpsMintKindPrev");
  const flippedAtRaw = source.runOpsMintKindFlippedAt;
  const parsed = typeof flippedAtRaw === "string" ? Date.parse(flippedAtRaw) : NaN;
  const flippedAtMs = Number.isNaN(parsed) ? undefined : parsed;
  return { kind, prev, flippedAtMs };
}

// SOURCE-CONSISTENT resolution: a per-org runOpsMintKind override wins the kind AND owns the
// grace stamp; with no per-org override, the kind AND the stamp both come from the global rows.
// The stamp is never read from a different source than the kind, which would date a grace
// window against the wrong flip.
export function resolveMintFlag(
  perOrgOverrides: Record<string, unknown> | null | undefined,
  globalFlags: Record<string, unknown> | null | undefined
): MintFlagResolution {
  if (readMintKind(perOrgOverrides ?? {}, "runOpsMintKind") !== undefined) {
    return readMintResolution(perOrgOverrides);
  }
  return readMintResolution(globalFlags);
}

// Picks the flag record that currently determines an org's effective mint kind: the per-org
// override blob when it sets runOpsMintKind, otherwise the global FeatureFlag rows. Same source
// resolveMintFlag() reads, but returned as a record so it can seed stampMintKindFlip's baseline
// (storedKind for flip-detection, prev on a genuine flip, and stamp carry-forward). This makes an
// org's first per-org override stamp against the effective GLOBAL kind, not the default "cuid".
export function selectMintBaselineSource(
  perOrgOverrides: Record<string, unknown> | null | undefined,
  globalFlags: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (readMintKind(perOrgOverrides ?? {}, "runOpsMintKind") !== undefined) {
    return perOrgOverrides ?? {};
  }
  return globalFlags ?? {};
}

function resolveEffectiveFromFlags(
  flags: Record<string, unknown> | null | undefined,
  nowMs: number,
  graceMs: number
): RunIdMintKind {
  return effectiveMintKind(readMintResolution(flags), nowMs, graceMs);
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
  // Only act when the save actually SETS runOpsMintKind. Omitting it (an unrelated flag change)
  // must not inject the default kind, which would pin the org and make a later global flip skip it.
  const outgoingKind = readMintKind(outgoingFlags, "runOpsMintKind");
  if (outgoingKind === undefined) {
    return outgoingFlags;
  }
  const storedKind = readMintKind(existingFlags ?? {}, "runOpsMintKind") ?? DEFAULT_MINT_KIND;

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
