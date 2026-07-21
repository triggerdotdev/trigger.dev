import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveMintKind,
  readMintResolution,
  resolveMintFlag,
  selectMintBaselineSource,
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

  it("leaves runOpsMintKind untouched when the save omits it (unrelated flag change: no inject, no spurious flip)", () => {
    const existing = { runOpsMintKind: "runOpsId" };
    const outgoing: Record<string, unknown> = { someOtherFlag: true };
    const result = stampMintKindFlip(existing, outgoing, T, GRACE_MS);

    // Must not inject a default kind or stamp a flip: doing so would pin the org to an explicit
    // per-org override and make a later global flip silently skip it.
    expect(result.runOpsMintKind).toBeUndefined();
    expect(result.runOpsMintKindPrev).toBeUndefined();
    expect(result.runOpsMintKindFlippedAt).toBeUndefined();
    expect(result.someOtherFlag).toBe(true);
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

// #3b: an org's FIRST per-org runOpsMintKind override must be stamped against the currently
// EFFECTIVE kind — the global FeatureFlag resolution when the org has no override yet — not the
// hardcoded default "cuid". selectMintBaselineSource picks that same source (per-org blob if it
// sets runOpsMintKind, else the global rows) so stampMintKindFlip's baseline (storedKind +
// prev + carry-forward) is correct.
describe("selectMintBaselineSource", () => {
  it("returns the per-org blob when it sets runOpsMintKind (override owns the baseline)", () => {
    const perOrg = { runOpsMintKind: "cuid" };
    const global = { runOpsMintKind: "runOpsId" };
    expect(selectMintBaselineSource(perOrg, global)).toBe(perOrg);
  });

  it("falls back to the global rows when the org has no runOpsMintKind override", () => {
    const perOrg = { someOtherFlag: true };
    const global = { runOpsMintKind: "runOpsId" };
    expect(selectMintBaselineSource(perOrg, global)).toBe(global);
  });

  it("returns an empty record when neither source sets a kind", () => {
    expect(selectMintBaselineSource(null, null)).toEqual({});
    expect(selectMintBaselineSource({ someOtherFlag: true }, null)).toEqual({});
  });
});

describe("first per-org override stamps prev against the effective GLOBAL kind (#3b)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("global=runOpsId, org's FIRST override -> cuid: genuine flip, prev=runOpsId, graced", () => {
    const globalFlags = { runOpsMintKind: "runOpsId" };
    const orgExisting = {}; // no per-org override yet
    const outgoing = { runOpsMintKind: "cuid" };
    const result = stampMintKindFlip(
      selectMintBaselineSource(orgExisting, globalFlags),
      outgoing,
      T,
      GRACE_MS
    );

    expect(result.runOpsMintKind).toBe("cuid");
    // Previously stamped prev="cuid" (the hardcoded default) OR skipped the flip entirely; must
    // now be "runOpsId" (the effective global kind) so the org serves it through the grace window.
    expect(result.runOpsMintKindPrev).toBe("runOpsId");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());

    const resolution = readMintResolution(result);
    expect(effectiveMintKind(resolution, T + GRACE_MS - 1, GRACE_MS)).toBe("runOpsId");
    expect(effectiveMintKind(resolution, T + GRACE_MS, GRACE_MS)).toBe("cuid");
  });

  it("global=runOpsId, org's FIRST override -> runOpsId (redundant): NOT a spurious flip, no phantom regression to cuid", () => {
    const globalFlags = { runOpsMintKind: "runOpsId" };
    const orgExisting = {};
    const outgoing = { runOpsMintKind: "runOpsId" };
    const result = stampMintKindFlip(
      selectMintBaselineSource(orgExisting, globalFlags),
      outgoing,
      T,
      GRACE_MS
    );

    expect(result.runOpsMintKind).toBe("runOpsId");
    // Previously: storedKind defaulted to "cuid", so this looked like a genuine flip and stamped
    // prev="cuid" — making the org serve cuid during a phantom grace window (a regression).
    expect(result.runOpsMintKindPrev).toBeUndefined();
    expect(result.runOpsMintKindFlippedAt).toBeUndefined();
  });

  it("mid-grace global flip carried into a redundant org override keeps the global stamp", () => {
    const globalFlags = {
      runOpsMintKind: "runOpsId",
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: new Date(T).toISOString(),
    };
    const orgExisting = {};
    const outgoing = { runOpsMintKind: "runOpsId" };
    const result = stampMintKindFlip(
      selectMintBaselineSource(orgExisting, globalFlags),
      outgoing,
      T + 10_000,
      GRACE_MS
    );

    expect(result.runOpsMintKind).toBe("runOpsId");
    expect(result.runOpsMintKindPrev).toBe("cuid");
    expect(result.runOpsMintKindFlippedAt).toBe(new Date(T).toISOString());
  });
});
