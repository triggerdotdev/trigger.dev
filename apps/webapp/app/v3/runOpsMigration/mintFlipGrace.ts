import { z } from "zod";
import {
  FeatureFlagCatalog,
  type FeatureFlagKey,
  GRACED_FLAG_GROUPS,
  isPlainFlagObject,
} from "~/v3/featureFlags";
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

// Boolean flags graced by the same mechanism, chosen by a `booleanRule` on their entry in
// GRACED_FLAG_GROUPS. The stamps of `<key>` are `<key>Prev` and `<key>FlippedAt`.

type FlagRecord = Record<string, unknown> | null | undefined;

// The record's value of `key` when it parses with the catalogue's schema (else a strict boolean).
function readValidBoolean(key: string, flags: unknown): boolean | undefined {
  if (!isPlainFlagObject(flags) || !Object.hasOwn(flags, key)) return undefined;
  const schema: z.ZodTypeAny = Object.hasOwn(FeatureFlagCatalog, key)
    ? FeatureFlagCatalog[key as FeatureFlagKey]
    : z.boolean();
  const parsed = schema.safeParse(flags[key]);
  return parsed.success ? parsed.data === true : undefined;
}

function stampRecordsOn(key: string, flags: unknown): boolean {
  return isPlainFlagObject(flags) && flags[`${key}Prev`] === true;
}

// effectiveMintKind's rule: the previous value until the change time plus the grace, when both
// parts of the stamp count; otherwise the value; otherwise off.
function servedBoolean(key: string, flags: unknown, nowMs: number, graceMs: number): boolean {
  const value = readValidBoolean(key, flags) ?? false;
  if (!isPlainFlagObject(flags)) return value;
  const prev = flags[`${key}Prev`];
  const flippedAtRaw = flags[`${key}FlippedAt`];
  const flippedAtMs = typeof flippedAtRaw === "string" ? Date.parse(flippedAtRaw) : NaN;
  if (typeof prev !== "boolean" || Number.isNaN(flippedAtMs)) return value;
  return nowMs < flippedAtMs + graceMs ? prev : value;
}

// Source-consistent, as resolveMintFlag: a valid organisation value owns the value AND the stamp.
export function readGracedBoolean(
  key: string,
  organizationFlags: unknown,
  globalFlags: Record<string, unknown> | undefined,
  nowMs: number,
  graceMs: number
): boolean {
  const source =
    readValidBoolean(key, organizationFlags) !== undefined
      ? organizationFlags
      : (globalFlags ?? {});
  return servedBoolean(key, source, nowMs, graceMs);
}

// Whether the flag is on, or a stamp that counts for the organisation records it was on.
export function hasBooleanBeenOn(
  key: string,
  organizationFlags: unknown,
  globalFlags: Record<string, unknown> | undefined
): boolean {
  const own = readValidBoolean(key, organizationFlags);
  if (own !== undefined) return own || stampRecordsOn(key, organizationFlags);
  return (
    readValidBoolean(key, globalFlags) === true ||
    stampRecordsOn(key, organizationFlags) ||
    stampRecordsOn(key, globalFlags)
  );
}

function copyDefinedStamp(key: string, from: FlagRecord, outgoingFlags: Record<string, unknown>) {
  for (const stampKey of [`${key}Prev`, `${key}FlippedAt`]) {
    const value = from?.[stampKey];
    if (value !== undefined) outgoingFlags[stampKey] = value;
  }
}

// stampMintKindFlip's shape with the keep-on rule: a change to off always records on, and a save
// that does not change the value keeps an own stamp that records on.
export function stampBooleanFlip(
  key: string,
  ownFlags: FlagRecord,
  globalFlags: FlagRecord,
  outgoingFlags: Record<string, unknown>,
  nowMs: number,
  graceMs: number
): Record<string, unknown> {
  const outgoing = readValidBoolean(key, outgoingFlags);
  if (outgoing === undefined) return outgoingFlags;

  const baseline = readValidBoolean(key, ownFlags) !== undefined ? ownFlags : globalFlags;
  const stored = readValidBoolean(key, baseline) ?? false;

  if (outgoing !== stored) {
    outgoingFlags[`${key}Prev`] = outgoing ? servedBoolean(key, baseline, nowMs, graceMs) : true;
    outgoingFlags[`${key}FlippedAt`] = new Date(nowMs).toISOString();
    return outgoingFlags;
  }

  copyDefinedStamp(key, stampRecordsOn(key, ownFlags) ? ownFlags : baseline, outgoingFlags);
  return outgoingFlags;
}

// A replace save that drops the key: an own value of on records on; otherwise the own stamp stays.
export function stampBooleanRemoval(
  key: string,
  ownFlags: FlagRecord,
  outgoingFlags: Record<string, unknown>,
  nowMs: number
): Record<string, unknown> {
  if (readValidBoolean(key, ownFlags) === true) {
    outgoingFlags[`${key}Prev`] = true;
    outgoingFlags[`${key}FlippedAt`] = new Date(nowMs).toISOString();
    return outgoingFlags;
  }
  copyDefinedStamp(key, ownFlags, outgoingFlags);
  return outgoingFlags;
}

const BOOLEAN_GRACED_GROUPS = GRACED_FLAG_GROUPS.filter((group) => group.booleanRule);

// The stamps of every boolean group are computed server-side, never accepted from a caller.
export function withoutBooleanFlagStamps(flags: Record<string, unknown>): Record<string, unknown> {
  const out = { ...flags };
  for (const group of BOOLEAN_GRACED_GROUPS) {
    for (const derived of group.derived) {
      delete out[derived];
    }
  }
  return out;
}

// The one call every admin writer makes for the boolean groups.
export function stampBooleanFlagGroups(
  ownFlags: FlagRecord,
  globalFlags: FlagRecord,
  outgoingFlags: Record<string, unknown>,
  nowMs: number,
  graceMs: number,
  options: { replace: boolean }
): Record<string, unknown> {
  for (const group of BOOLEAN_GRACED_GROUPS) {
    if (readValidBoolean(group.primary, outgoingFlags) !== undefined) {
      stampBooleanFlip(group.primary, ownFlags, globalFlags, outgoingFlags, nowMs, graceMs);
    } else if (options.replace && group.booleanRule === "keepOn") {
      stampBooleanRemoval(group.primary, ownFlags, outgoingFlags, nowMs);
    }
  }
  return outgoingFlags;
}
