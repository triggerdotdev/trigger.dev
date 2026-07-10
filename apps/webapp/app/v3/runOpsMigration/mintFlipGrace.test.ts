import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveMintKind,
  resolveMintFlag,
  stampMintKindFlip,
  type MintFlagResolution,
} from "./mintFlipGrace";

// GRACE-LINGER: during [flippedAt, flippedAt + GRACE) every process — stale or fresh —
// must resolve to the SAME (old) kind; at/after the cutover every process resolves to
// the SAME (new) kind. This collapses the cross-process divergence window.
const GRACE_MS = 90_000;
const T = 1_000_000;

describe("effectiveMintKind", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns r.kind directly when prev is missing", () => {
    const r: MintFlagResolution = { kind: "cuid" };
    expect(effectiveMintKind(r, T, GRACE_MS)).toBe("cuid");
  });

  it("returns r.kind directly when flippedAtMs is missing", () => {
    const r: MintFlagResolution = { kind: "runOpsId", prev: "cuid" };
    expect(effectiveMintKind(r, T, GRACE_MS)).toBe("runOpsId");
  });

  it("CORE: stale and fresh resolutions agree at every instant during grace, then both flip to the new kind at cutover", () => {
    const stale: MintFlagResolution = { kind: "cuid" };
    const fresh: MintFlagResolution = { kind: "runOpsId", prev: "cuid", flippedAtMs: T };

    for (const now of [T, T + 1, T + 1_000, T + 45_000, T + GRACE_MS - 1]) {
      const staleResolved = effectiveMintKind(stale, now, GRACE_MS);
      const freshResolved = effectiveMintKind(fresh, now, GRACE_MS);
      expect(staleResolved).toBe("cuid");
      expect(freshResolved).toBe("cuid");
    }

    for (const now of [T + GRACE_MS, T + GRACE_MS + 1, T + GRACE_MS + 60_000]) {
      expect(effectiveMintKind(fresh, now, GRACE_MS)).toBe("runOpsId");
    }
  });

  it("boundary: exactly at flippedAt + GRACE resolves to the NEW kind", () => {
    const fresh: MintFlagResolution = { kind: "runOpsId", prev: "cuid", flippedAtMs: T };
    expect(effectiveMintKind(fresh, T + GRACE_MS - 1, GRACE_MS)).toBe("cuid");
    expect(effectiveMintKind(fresh, T + GRACE_MS, GRACE_MS)).toBe("runOpsId");
  });
});

describe("stampMintKindFlip", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a genuine flip (cuid -> runOpsId) stamps prev and flippedAt", () => {
    const existing = { runOpsMintKind: "cuid" };
    const outgoing = { runOpsMintKind: "runOpsId" };
    const result = stampMintKindFlip(existing, outgoing, T, GRACE_MS);

    expect(result.runOpsMintKind).toBe("runOpsId");
    expect(result.runOpsMintKindPrev).toBe("cuid");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
  });

  it("defaults the existing effective kind to cuid when existing flags are null", () => {
    const outgoing = { runOpsMintKind: "runOpsId" };
    const result = stampMintKindFlip(null, outgoing, T, GRACE_MS);

    expect(result.runOpsMintKind).toBe("runOpsId");
    expect(result.runOpsMintKindPrev).toBe("cuid");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
  });

  it("resubmitting the same target kind mid-grace carries the stamp forward untouched (does not reset the cutover clock)", () => {
    const existing = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const now = T + 10_000;
    const outgoing = { runOpsMintKind: "runOpsId", someOtherFlag: true };
    const result = stampMintKindFlip(existing, outgoing, now, GRACE_MS);

    expect(result.runOpsMintKind).toBe("runOpsId");
    expect(result.runOpsMintKindPrev).toBe("cuid");
    // Unrelated re-save: the cutover time must NOT slide forward.
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
    expect(result.someOtherFlag).toBe(true);
  });

  it("an unchanged save after grace has elapsed carries the settled stamp forward and preserves unrelated flags", () => {
    const existing = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const outgoing = { runOpsMintKind: "runOpsId", someOtherFlag: true };
    const result = stampMintKindFlip(existing, outgoing, T + GRACE_MS + 5_000, GRACE_MS);

    expect(result.runOpsMintKind).toBe("runOpsId");
    expect(result.someOtherFlag).toBe(true);
    expect(result.runOpsMintKindPrev).toBe("cuid");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
  });

  it("a flip-back requested after the original grace has elapsed stamps prev := the new settled (now-effective) kind, timestamped now", () => {
    const existing = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const now = T + GRACE_MS + 1_000;
    const outgoing = { runOpsMintKind: "cuid" };
    const result = stampMintKindFlip(existing, outgoing, now, GRACE_MS);

    expect(result.runOpsMintKind).toBe("cuid");
    expect(result.runOpsMintKindPrev).toBe("runOpsId");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(now).toISOString());
  });

  it("a flip-back mid-grace re-stamps prev to the still-effective old kind, so it keeps serving that kind (no divergence)", () => {
    const existing = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const now = T + 20_000;
    const outgoing = { runOpsMintKind: "cuid" };
    const result = stampMintKindFlip(existing, outgoing, now, GRACE_MS);

    expect(result.runOpsMintKind).toBe("cuid");
    expect(result.runOpsMintKindPrev).toBe("cuid");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(now).toISOString());
  });

  it("defaults outgoing kind to 'cuid' when runOpsMintKind is absent", () => {
    const existing = { runOpsMintKind: "runOpsId" };
    const outgoing: Record<string, unknown> = {};
    const result = stampMintKindFlip(existing, outgoing, T, GRACE_MS);

    expect(result.runOpsMintKind).toBe("cuid");
    expect(result.runOpsMintKindPrev).toBe("runOpsId");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
  });

  it("treats a malformed existing flippedAt as no stamp", () => {
    const existing = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: "not-a-date",
    };
    const outgoing = { runOpsMintKind: "runOpsId" };
    const result = stampMintKindFlip(existing, outgoing, T, GRACE_MS);

    expect(result.runOpsMintKind).toBe("runOpsId");
    // The malformed flippedAt is carried forward verbatim, but an unparseable timestamp is
    // inert when resolved (Date.parse -> NaN -> effectiveMintKind returns the target kind).
    expect(result.runOpsMintKindFlippedAt).toBe("not-a-date");
    expect(
      effectiveMintKind({ kind: "runOpsId", prev: "cuid", flippedAtMs: NaN }, T, GRACE_MS)
    ).toBe("runOpsId");
  });
});

// SOURCE-CONSISTENCY: the kind and its grace stamp must come from the SAME source. A per-org
// runOpsMintKind override wins both the kind and the stamp; with no per-org override, BOTH the
// kind and the stamp come from the global FeatureFlag rows. Never mix (e.g. a per-org kind with
// the global stamp), which would date a grace window against the wrong flip.
describe("resolveMintFlag", () => {
  it("a per-org override wins the kind AND owns the stamp, ignoring the global stamp entirely", () => {
    const perOrg = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const global = {
      runOpsMintKind: "cuid",
      runOpsMintKindPrev: "runOpsId",
      runOpsMintKindFlippedAt: new Date(T + 500_000).toISOString(),
    };
    expect(resolveMintFlag(perOrg, global)).toEqual({
      kind: "runOpsId",
      prev: "cuid",
      flippedAtMs: T,
    });
  });

  it("with NO per-org override, the kind AND the stamp come from the global rows (global flip is graced)", () => {
    const global = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const resolution = resolveMintFlag({}, global);
    expect(resolution).toEqual({ kind: "runOpsId", prev: "cuid", flippedAtMs: T });
    // Mid-grace: a global flip resolves to the OLD kind for the whole window.
    expect(effectiveMintKind(resolution, T + GRACE_MS - 1, GRACE_MS)).toBe("cuid");
    expect(effectiveMintKind(resolution, T + GRACE_MS, GRACE_MS)).toBe("runOpsId");
  });

  it("a per-org override with NO per-org stamp does NOT borrow the global stamp (kind stays ungraced)", () => {
    const perOrg = { runOpsMintKind: "runOpsId" };
    const global = {
      runOpsMintKind: "cuid",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    expect(resolveMintFlag(perOrg, global)).toEqual({
      kind: "runOpsId",
      prev: undefined,
      flippedAtMs: undefined,
    });
  });

  it("defaults to cuid with no stamp when neither source has a kind", () => {
    expect(resolveMintFlag({}, {})).toEqual({
      kind: "cuid",
      prev: undefined,
      flippedAtMs: undefined,
    });
    expect(resolveMintFlag(null, null)).toEqual({
      kind: "cuid",
      prev: undefined,
      flippedAtMs: undefined,
    });
  });
});
