import { describe, expect, it } from "vitest";
import { APPEND_RESULT_OUTCOMES } from "./redisSnapshotStore.js";
import type { AppendResult } from "./redisSnapshotStore.js";

describe("append result outcomes", () => {
  it("lists every outcome the store can return", () => {
    // A type error here means AppendResult moved and the list did not follow. The metrics layer
    // bounds against this list, so an omitted outcome collapses to "other".
    type Declared = (typeof APPEND_RESULT_OUTCOMES)[number];
    type Actual = AppendResult["outcome"];
    type AssertSame<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
    const _covers: AssertSame<Declared, Actual> = true;
    void _covers;

    expect([...APPEND_RESULT_OUTCOMES].sort()).toEqual([
      "duplicate",
      "forked",
      "skippedNoKeyspace",
      "written",
    ]);
  });

  it("uses the result vocabulary, not the Lua wire vocabulary", () => {
    expect(APPEND_RESULT_OUTCOMES).not.toContain("skipped");
    expect(APPEND_RESULT_OUTCOMES).toContain("skippedNoKeyspace");
  });
});
