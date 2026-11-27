import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  effectiveMintKind,
  hasBooleanBeenOn,
  readGracedBoolean,
  readMintResolution,
  resolveMintFlag,
  selectMintBaselineSource,
  stampBooleanFlagGroups,
  stampBooleanFlip,
  stampBooleanRemoval,
  stampMintKindFlip,
  withoutBooleanFlagStamps,
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

const SWITCH = "runResidencyEnabled";
const at = (ms: number) => new Date(ms).toISOString();
const EARLIER = at(T - 10_000);

describe("stampBooleanFlip", () => {
  const flip = (
    own: Record<string, unknown> | null,
    global: Record<string, unknown> | null,
    outgoing: Record<string, unknown>
  ) => stampBooleanFlip(SWITCH, own, global, outgoing, T, GRACE_MS);

  // Catches: a change to on stamping the new value instead of the value the baseline served.
  it("a change from off to on stamps the served off, with no baseline stamp", () => {
    expect(flip({ runResidencyEnabled: false }, null, { runResidencyEnabled: true })).toEqual({
      runResidencyEnabled: true,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a change to on dropping the on the baseline still serves inside its grace.
  it("a change from off to on inside the grace of a change from on stamps the served on", () => {
    const own = {
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: EARLIER,
    };
    expect(flip(own, null, { runResidencyEnabled: true })).toEqual({
      runResidencyEnabled: true,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a change to off that records off, losing the record that the switch was on.
  it("a change from on to off stamps true", () => {
    expect(flip({ runResidencyEnabled: true }, null, { runResidencyEnabled: false })).toEqual({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a change to off stamping the served value, off inside the grace of a change to on.
  it("a change from on to off inside the grace of a change to on still stamps true", () => {
    const own = {
      runResidencyEnabled: true,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: EARLIER,
    };
    expect(flip(own, null, { runResidencyEnabled: false })).toEqual({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a resave that resets the cutover clock or drops the baseline stamp.
  it("a save that does not change the value carries the baseline stamp", () => {
    const global = {
      runResidencyEnabled: true,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: EARLIER,
    };
    expect(flip({}, global, { runResidencyEnabled: true })).toEqual(global);
  });

  // Catches: the no-change branch dropping the own stamp that records on for the baseline's.
  it("a save that does not change the value keeps an own stamp recording on over a baseline stamp recording off", () => {
    const own = { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: EARLIER };
    const global = {
      runResidencyEnabled: false,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: at(T - 50_000),
    };
    expect(flip(own, global, { runResidencyEnabled: false })).toEqual({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: EARLIER,
    });
  });

  // Catches: the no-change branch dropping the own stamp that records on when the baseline has none.
  it("a save that does not change the value keeps an own stamp recording on over no baseline stamp", () => {
    const own = { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: EARLIER };
    expect(flip(own, { runResidencyEnabled: false }, { runResidencyEnabled: false })).toEqual({
      runResidencyEnabled: false,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: EARLIER,
    });
  });

  // Catches: the baseline taken from the global flags over a valid own value.
  it("takes the own flags as the baseline when they hold a valid value", () => {
    expect(
      flip(
        { runResidencyEnabled: true },
        { runResidencyEnabled: false },
        { runResidencyEnabled: true }
      )
    ).toEqual({ runResidencyEnabled: true });
  });

  // Catches: an own invalid value ("true") read as the stored value instead of the global one.
  it("takes the global flags as the baseline when the own value is invalid", () => {
    expect(
      flip(
        { runResidencyEnabled: "true" },
        { runResidencyEnabled: false },
        { runResidencyEnabled: true }
      )
    ).toEqual({
      runResidencyEnabled: true,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a save that does not set the switch gaining a stamp.
  it("returns outgoing flags with no valid value of the key unchanged", () => {
    const outgoing = { runResidencyEnabled: "true", hasQueryAccess: true };
    expect(flip({ runResidencyEnabled: true }, null, outgoing)).toBe(outgoing);
    expect(outgoing).toEqual({ runResidencyEnabled: "true", hasQueryAccess: true });
    expect(flip({ runResidencyEnabled: true }, null, {})).toEqual({});
  });
});

describe("stampBooleanRemoval", () => {
  // Catches: removing an on switch without recording that it was on.
  it("own on records on at the change time", () => {
    expect(stampBooleanRemoval(SWITCH, { runResidencyEnabled: true }, {}, T)).toEqual({
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: the removal stamp written for an own value of off.
  it("own off carries the own stamp unchanged", () => {
    const stamp = { runResidencyEnabledPrev: false, runResidencyEnabledFlippedAt: EARLIER };
    expect(stampBooleanRemoval(SWITCH, { runResidencyEnabled: false, ...stamp }, {}, T)).toEqual(
      stamp
    );
  });

  // Catches: a removal dropping the stamp an org kept after its switch was removed.
  it("own with no value and a stamp carries it", () => {
    const stamp = { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: EARLIER };
    expect(stampBooleanRemoval(SWITCH, stamp, {}, T)).toEqual(stamp);
  });

  // Catches: a removal inventing a stamp where there was nothing.
  it("own with neither writes no stamp key", () => {
    expect(
      stampBooleanRemoval(SWITCH, { hasQueryAccess: true }, { hasQueryAccess: true }, T)
    ).toEqual({ hasQueryAccess: true });
  });
});

describe("stampBooleanFlagGroups", () => {
  // Catches: the helper not applying the set-key stamp to a save that sets the switch.
  it("applies the set-key stamp when the outgoing flags hold the switch", () => {
    const out = stampBooleanFlagGroups(
      { runResidencyEnabled: false },
      null,
      { runResidencyEnabled: true },
      T,
      GRACE_MS,
      { replace: false }
    );
    expect(out).toEqual({
      runResidencyEnabled: true,
      runResidencyEnabledPrev: false,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: a merge save, which cannot remove a key, treated as a removal.
  it("applies the removal stamp only with replace", () => {
    const own = { runResidencyEnabled: true };
    expect(stampBooleanFlagGroups(own, null, {}, T, GRACE_MS, { replace: false })).toEqual({});
    expect(stampBooleanFlagGroups(own, null, {}, T, GRACE_MS, { replace: true })).toEqual({
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(T),
    });
  });

  // Catches: the helper stamping, or carrying the stamps of, a group with no booleanRule.
  it("touches no key of a group with no booleanRule", () => {
    const own = {
      runOpsMintKind: "cuid",
      runOpsMintKindPrev: "runOpsId",
      runOpsMintKindFlippedAt: EARLIER,
      runOpsMintShardSet: "a",
      runOpsMintShardSetPrev: "",
      runOpsMintShardSetFlippedAt: EARLIER,
    };
    const outgoing = { runOpsMintKind: "runOpsId", runOpsMintShardSet: "a,b" };
    for (const replace of [false, true]) {
      expect(stampBooleanFlagGroups(own, own, { ...outgoing }, T, GRACE_MS, { replace })).toEqual(
        outgoing
      );
    }
  });
});

describe("withoutBooleanFlagStamps", () => {
  // Catches: a body-supplied switch stamp kept, or another group's stamp stripped.
  it("removes the switch's stamps, keeps the others, and does not mutate its input", () => {
    const input = {
      runResidencyEnabled: true,
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: EARLIER,
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: EARLIER,
      runOpsMintShardSetPrev: "a",
      runOpsMintShardSetFlippedAt: EARLIER,
    };
    const snapshot = { ...input };
    expect(withoutBooleanFlagStamps(input)).toEqual({
      runResidencyEnabled: true,
      runOpsMintKindPrev: "cuid",
      runOpsMintKindFlippedAt: EARLIER,
      runOpsMintShardSetPrev: "a",
      runOpsMintShardSetFlippedAt: EARLIER,
    });
    expect(input).toEqual(snapshot);
  });
});

describe("readGracedBoolean", () => {
  const read = (org: unknown, global: Record<string, unknown> | undefined, nowMs: number) =>
    readGracedBoolean(SWITCH, org, global, nowMs, GRACE_MS);
  const offFromOn = {
    runResidencyEnabled: false,
    runResidencyEnabledPrev: true,
    runResidencyEnabledFlippedAt: at(T),
  };

  // Catches: an organisation stamp not served for its grace, or served after it.
  it("serves an organisation stamp's previous value inside the grace, then the value", () => {
    expect(read(offFromOn, undefined, T + 1_000)).toBe(true);
    expect(read(offFromOn, undefined, T + GRACE_MS)).toBe(false);
  });

  // Catches: a global stamp ignored when the organisation has no override.
  it("serves a global stamp the same way with no override", () => {
    expect(read({}, offFromOn, T + 1_000)).toBe(true);
    expect(read({}, offFromOn, T + GRACE_MS)).toBe(false);
  });

  // Catches: the read taking the stamp from the global flags under an organisation override.
  it("never takes the global stamp under a valid organisation override", () => {
    expect(read({ runResidencyEnabled: false }, offFromOn, T + 1_000)).toBe(false);
  });

  // Catches: an invalid override ("true") owning the value or the stamp.
  it("takes the global value and stamp under an invalid override", () => {
    expect(read({ runResidencyEnabled: "true" }, offFromOn, T + 1_000)).toBe(true);
    expect(read({ runResidencyEnabled: "true" }, offFromOn, T + GRACE_MS)).toBe(false);
    expect(read({ runResidencyEnabled: "true" }, { runResidencyEnabled: true }, T)).toBe(true);
  });

  // Catches: a stamp that does not parse served as if it did.
  it("serves the value when the change time does not parse or the previous value is not a boolean", () => {
    expect(
      read({ ...offFromOn, runResidencyEnabledFlippedAt: "yesterday" }, undefined, T + 1_000)
    ).toBe(false);
    expect(read({ ...offFromOn, runResidencyEnabledPrev: "true" }, undefined, T + 1_000)).toBe(
      false
    );
  });

  // Catches: a global switch removed while on cutting over with no grace.
  it("serves a removed global switch's stamp recording on for its grace, then off", () => {
    const removed = (flippedAtMs: number) => ({
      runResidencyEnabledPrev: true,
      runResidencyEnabledFlippedAt: at(flippedAtMs),
    });
    expect(read({}, removed(T), T)).toBe(true);
    expect(read({}, removed(T - 2 * 60 * 60 * 1000), T)).toBe(false);
  });
});

describe("hasBooleanBeenOn", () => {
  const recordsOn = { runResidencyEnabledPrev: true, runResidencyEnabledFlippedAt: EARLIER };
  const recordsOff = { runResidencyEnabledPrev: false, runResidencyEnabledFlippedAt: EARLIER };

  // Catches: "has been on" missing a switch that is on, or a stamp that records on.
  it.each<[string, Record<string, unknown>, Record<string, unknown> | undefined]>([
    ["the switch on by override", { runResidencyEnabled: true }, undefined],
    ["the switch on globally", {}, { runResidencyEnabled: true }],
    [
      "an organisation stamp recording on, switch off",
      { runResidencyEnabled: false, ...recordsOn },
      {},
    ],
    ["an organisation stamp recording on, switch removed", recordsOn, {}],
    ["a global stamp recording on, no override", {}, recordsOn],
    ["a global stamp recording on, invalid override", { runResidencyEnabled: "true" }, recordsOn],
  ])("is true for %s", (_name, org, global) => {
    expect(hasBooleanBeenOn(SWITCH, org, global)).toBe(true);
  });

  // Catches: the global stamp counted under a valid override, or a stamp recording off counted.
  it.each<[string, Record<string, unknown>, Record<string, unknown> | undefined]>([
    [
      "a global stamp recording on under an override of off",
      { runResidencyEnabled: false },
      recordsOn,
    ],
    [
      "the switch on globally under an override of off",
      { runResidencyEnabled: false },
      { runResidencyEnabled: true },
    ],
    ["stamps recording off", { runResidencyEnabled: false, ...recordsOff }, recordsOff],
    ["no switch and no stamp", {}, undefined],
  ])("is false for %s", (_name, org, global) => {
    expect(hasBooleanBeenOn(SWITCH, org, global)).toBe(false);
  });
});
