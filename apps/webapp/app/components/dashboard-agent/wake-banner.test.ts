// The wake banner's headline: what the user reads before the narration. The rule
// pinned here is that an expiry with an ANSWER ("it can't happen any more") never
// reads as the silent "no answer" expiry.
import { describe, expect, it } from "vitest";
import { wakeHeadline } from "./WakeBanner";

describe("wakeHeadline", () => {
  it("says the condition can no longer happen when the watch ended terminally", () => {
    expect(wakeHeadline("expired", { endedReason: "terminal_unsatisfied" }, "neutral")).toBe(
      "Watch ended — the condition can no longer happen"
    );
  });

  it("keeps the plain expiry when the watch simply ran out of time", () => {
    for (const watch of [undefined, { endedReason: null }, { endedReason: "not_met_by_expiry" }]) {
      expect(wakeHeadline("expired", watch, "neutral")).toBe("Watch expired — no answer");
    }
  });

  it("words a fire by its tone", () => {
    expect(wakeHeadline("fired", undefined, "success")).toBe("Watch update — all clear");
    expect(wakeHeadline("fired", undefined, "error")).toBe("Watch update — needs your attention");
    expect(wakeHeadline("fired", undefined, "neutral")).toBe("Watch update — condition met");
  });
});
