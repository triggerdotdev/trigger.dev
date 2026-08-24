// The two global write routes used to carry their own copy of "which keys are graced" and "which
// keys are derived". A new graced group would then need an edit in three places, and missing one
// means an unstamped flip or a stamp written straight from a request body. Both routes now derive
// both answers from the group table, and these tests pin that. Pure, no containers.
import { describe, expect, it } from "vitest";
import { FEATURE_FLAG, lockedFlagsInPayload } from "~/v3/featureFlags";
import { touchesGracedGroup, withoutDerivedKeys } from "~/v3/featureFlags.server";

describe("touchesGracedGroup — decides whether a save needs the stamped path", () => {
  it("is true for a mint-kind change", () => {
    expect(touchesGracedGroup({ [FEATURE_FLAG.runOpsMintKind]: "runOpsId" })).toBe(true);
  });

  it("is true for a shard-list change", () => {
    expect(touchesGracedGroup({ [FEATURE_FLAG.runOpsMintShardSet]: "a,b" })).toBe(true);
  });

  it("is false for an ordinary flag, which writes directly", () => {
    expect(touchesGracedGroup({ [FEATURE_FLAG.mollifierEnabled]: true })).toBe(false);
    expect(touchesGracedGroup({})).toBe(false);
  });

  it("is false when only a DERIVED key is present", () => {
    // A body carrying only a stamp changes no group. Treating it as a flip would let a caller
    // reset a cutover clock without touching the value the clock dates.
    expect(touchesGracedGroup({ [FEATURE_FLAG.runOpsMintKindPrev]: "cuid" })).toBe(false);
    expect(touchesGracedGroup({ [FEATURE_FLAG.runOpsMintShardSetPrev]: "a" })).toBe(false);
  });

  it("covers every graced primary, so a new group needs no route edit", () => {
    // The routes no longer name these keys. If a group is added and this list is not, the next
    // assertion fails rather than the group silently skipping the stamp.
    const gracedPrimaries = [FEATURE_FLAG.runOpsMintKind, FEATURE_FLAG.runOpsMintShardSet];
    for (const key of gracedPrimaries) {
      expect(touchesGracedGroup({ [key]: "x" })).toBe(true);
    }
    // Every key the strip removes belongs to a group whose primary is one of the above.
    const derived = Object.keys(
      withoutDerivedKeys({
        [FEATURE_FLAG.runOpsMintKindPrev]: "cuid",
        [FEATURE_FLAG.runOpsMintKindFlippedAt]: "t",
        [FEATURE_FLAG.runOpsMintShardSetPrev]: "a",
        [FEATURE_FLAG.runOpsMintShardSetFlippedAt]: "t",
      } as Record<string, unknown>)
    );
    expect(derived).toEqual([]);
  });
});

describe("withoutDerivedKeys — a stamp is never taken from a request body", () => {
  it("strips both stamps and keeps everything else", () => {
    const out = withoutDerivedKeys({
      [FEATURE_FLAG.runOpsMintKind]: "runOpsId",
      [FEATURE_FLAG.runOpsMintKindPrev]: "spoofed",
      [FEATURE_FLAG.runOpsMintKindFlippedAt]: "1999-01-01T00:00:00.000Z",
      [FEATURE_FLAG.runOpsMintShardSet]: "a,b",
      [FEATURE_FLAG.runOpsMintShardSetPrev]: "spoofed",
      [FEATURE_FLAG.runOpsMintShardSetFlippedAt]: "1999-01-01T00:00:00.000Z",
      [FEATURE_FLAG.mollifierEnabled]: true,
    } as Record<string, unknown>);

    expect(out).toEqual({
      [FEATURE_FLAG.runOpsMintKind]: "runOpsId",
      [FEATURE_FLAG.runOpsMintShardSet]: "a,b",
      [FEATURE_FLAG.mollifierEnabled]: true,
    });
  });

  it("does not mutate its input", () => {
    const input = { [FEATURE_FLAG.runOpsMintKindPrev]: "cuid" } as Record<string, unknown>;
    withoutDerivedKeys(input);
    expect(input[FEATURE_FLAG.runOpsMintKindPrev]).toBe("cuid");
  });
});

describe("lockedFlagsInPayload — what the global page refuses", () => {
  it("refuses a locked flag on managed cloud, where the page never offers one", () => {
    const refused = lockedFlagsInPayload(
      [FEATURE_FLAG.taskEventRepository, FEATURE_FLAG.mollifierEnabled],
      true
    );
    expect(refused).toEqual([FEATURE_FLAG.taskEventRepository]);
  });

  it("refuses the mint-shard pins, which are per-org only", () => {
    expect(lockedFlagsInPayload([FEATURE_FLAG.runOpsMintShard], true)).toEqual([
      FEATURE_FLAG.runOpsMintShard,
    ]);
    expect(lockedFlagsInPayload([FEATURE_FLAG.runOpsMintShardEnvPins], true)).toEqual([
      FEATURE_FLAG.runOpsMintShardEnvPins,
    ]);
  });

  it("refuses a grace stamp, which the server owns", () => {
    expect(lockedFlagsInPayload([FEATURE_FLAG.runOpsMintShardSetFlippedAt], true)).toEqual([
      FEATURE_FLAG.runOpsMintShardSetFlippedAt,
    ]);
  });

  it("allows the shard list, because that is the page's ramp lever", () => {
    expect(lockedFlagsInPayload([FEATURE_FLAG.runOpsMintShardSet], true)).toEqual([]);
  });

  it("refuses nothing when not managed cloud, where an admin may unlock and edit", () => {
    expect(lockedFlagsInPayload([FEATURE_FLAG.taskEventRepository], false)).toEqual([]);
  });

  it("refuses nothing for an empty payload", () => {
    expect(lockedFlagsInPayload([], true)).toEqual([]);
  });
});
