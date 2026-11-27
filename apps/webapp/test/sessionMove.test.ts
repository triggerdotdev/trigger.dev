import { describe, expect, it } from "vitest";
import { parseSupersededRunCancelReason, supersededRunCancelReason } from "~/utils/sessionMove";

describe("supersededRunCancelReason", () => {
  it("round-trips through its parser", () => {
    const parts = { movedToVersion: "20261109.18", newRunFriendlyId: "run_cmw9r7pij002y" };
    // Catches: the text and the pattern drifting apart, which hides a move in flight from the
    // run manager and from the run page.
    expect(parseSupersededRunCancelReason(supersededRunCancelReason(parts))).toEqual(parts);
    // A task threshold names its task, and a task id is free text.
    for (const taskIdentifier of [
      "support-agent",
      "a task. Continued in run_x.",
      "for you",
      "support\nagent",
    ]) {
      const withTask = { ...parts, taskIdentifier };
      expect(parseSupersededRunCancelReason(supersededRunCancelReason(withTask))).toEqual(withTask);
    }
  });

  it("ignores any other cancel reason", () => {
    expect(parseSupersededRunCancelReason("Canceled by user")).toBeUndefined();
    expect(parseSupersededRunCancelReason("Moved to 20261109.18 by hand.")).toBeUndefined();
    expect(parseSupersededRunCancelReason(null)).toBeUndefined();
  });
});
