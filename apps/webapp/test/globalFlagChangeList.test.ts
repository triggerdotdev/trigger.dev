// Two properties of a global flag save that the admin page had no way to state.
//
// 1. Unsetting a graced primary clears its server-computed stamps too. Those keys are locked, so
//    they are absent from the page's editable set, and the confirm dialog listed one removal
//    while three rows were deleted.
// 2. A save should write only the flags whose value actually changed. Writing every submitted
//    flag costs one round trip each inside an interactive transaction.
import { describe, expect, it } from "vitest";
import { FEATURE_FLAG, derivedFlagsClearedWith } from "~/v3/featureFlags";
import { flagsNeedingWrite } from "~/v3/featureFlags.server";
import { buildFlagChangeList } from "~/components/admin/flagChangeList";

const LOCKED = [
  FEATURE_FLAG.runOpsMintKindPrev,
  FEATURE_FLAG.runOpsMintKindFlippedAt,
  FEATURE_FLAG.runOpsMintShardSetPrev,
  FEATURE_FLAG.runOpsMintShardSetFlippedAt,
] as string[];

// Sorted, as the dialog sorts before calling: the builder preserves the order it is given.
const EDITABLE = [
  FEATURE_FLAG.runOpsMintKind,
  FEATURE_FLAG.runOpsMintShardSet,
  FEATURE_FLAG.mollifierEnabled,
].sort() as string[];

describe("derivedFlagsClearedWith", () => {
  it("names the stamps that go with a graced primary", () => {
    expect(derivedFlagsClearedWith(FEATURE_FLAG.runOpsMintKind)).toEqual([
      FEATURE_FLAG.runOpsMintKindPrev,
      FEATURE_FLAG.runOpsMintKindFlippedAt,
    ]);
    expect(derivedFlagsClearedWith(FEATURE_FLAG.runOpsMintShardSet)).toEqual([
      FEATURE_FLAG.runOpsMintShardSetPrev,
      FEATURE_FLAG.runOpsMintShardSetFlippedAt,
    ]);
  });

  it("names nothing for an ordinary flag, or for a stamp itself", () => {
    expect(derivedFlagsClearedWith(FEATURE_FLAG.mollifierEnabled)).toEqual([]);
    expect(derivedFlagsClearedWith(FEATURE_FLAG.runOpsMintKindPrev)).toEqual([]);
  });
});

describe("buildFlagChangeList — what the confirm dialog must show", () => {
  it("lists an added, a changed and a removed flag", () => {
    const changes = buildFlagChangeList({
      editableKeys: EDITABLE,
      lockedKeys: LOCKED,
      initialValues: { mollifierEnabled: true, runOpsMintShardSet: "a" },
      storedValues: { mollifierEnabled: true, runOpsMintShardSet: "a" },
      newValues: { runOpsMintShardSet: "a,b", runOpsMintKind: "runOpsId" },
    });

    expect(changes).toEqual([
      { key: FEATURE_FLAG.mollifierEnabled, type: "removed", oldVal: "true" },
      { key: FEATURE_FLAG.runOpsMintKind, type: "added", newVal: "runOpsId" },
      { key: FEATURE_FLAG.runOpsMintShardSet, type: "changed", oldVal: "a", newVal: "a,b" },
    ]);
  });

  it("discloses the stamps cleared alongside an unset graced primary", () => {
    // Three rows are deleted, so three removals must be shown, not one. The caller filters
    // locked keys OUT of initialValues, so the stamps are only visible in storedValues.
    const changes = buildFlagChangeList({
      editableKeys: EDITABLE,
      lockedKeys: LOCKED,
      initialValues: { runOpsMintShardSet: "a,b" },
      storedValues: {
        runOpsMintShardSet: "a,b",
        runOpsMintShardSetPrev: "a",
        runOpsMintShardSetFlippedAt: "2026-08-24T00:00:00.000Z",
      },
      newValues: {},
    });

    expect(changes.map((c) => c.key)).toEqual([
      FEATURE_FLAG.runOpsMintShardSet,
      FEATURE_FLAG.runOpsMintShardSetPrev,
      FEATURE_FLAG.runOpsMintShardSetFlippedAt,
    ]);
    expect(changes.every((c) => c.type === "removed")).toBe(true);
  });

  it("does not disclose a stamp that is not stored", () => {
    const changes = buildFlagChangeList({
      editableKeys: EDITABLE,
      lockedKeys: LOCKED,
      initialValues: { runOpsMintShardSet: "a,b" },
      storedValues: { runOpsMintShardSet: "a,b" },
      newValues: {},
    });
    expect(changes.map((c) => c.key)).toEqual([FEATURE_FLAG.runOpsMintShardSet]);
  });

  it("does not disclose stamps when the primary is only CHANGED", () => {
    // A change re-stamps rather than clearing, so nothing is removed.
    const changes = buildFlagChangeList({
      editableKeys: EDITABLE,
      lockedKeys: LOCKED,
      initialValues: { runOpsMintShardSet: "a" },
      storedValues: { runOpsMintShardSet: "a", runOpsMintShardSetPrev: "" },
      newValues: { runOpsMintShardSet: "a,b" },
    });
    expect(changes.map((c) => c.key)).toEqual([FEATURE_FLAG.runOpsMintShardSet]);
  });

  it("never lists a locked key on its own", () => {
    const changes = buildFlagChangeList({
      editableKeys: EDITABLE,
      lockedKeys: LOCKED,
      initialValues: {},
      storedValues: { runOpsMintShardSetPrev: "a" },
      newValues: {},
    });
    expect(changes).toEqual([]);
  });
});

describe("flagsNeedingWrite — one round trip per CHANGED flag, not per submitted flag", () => {
  it("drops a submitted flag whose stored value already matches", () => {
    const out = flagsNeedingWrite(
      { mollifierEnabled: true, hasAiAccess: true },
      { mollifierEnabled: true, hasAiAccess: false }
    );
    expect(out).toEqual({ hasAiAccess: true });
  });

  it("keeps a flag that is absent from storage", () => {
    expect(flagsNeedingWrite({ mollifierEnabled: true }, {})).toEqual({ mollifierEnabled: true });
  });

  it("returns nothing when a save changes nothing", () => {
    expect(flagsNeedingWrite({ mollifierEnabled: true }, { mollifierEnabled: true })).toEqual({});
  });

  it("compares by value, not by reference, so a CSV rewritten the same way is not a write", () => {
    expect(flagsNeedingWrite({ runOpsMintShardSet: "a,b" }, { runOpsMintShardSet: "a,b" })).toEqual(
      {}
    );
  });
});
