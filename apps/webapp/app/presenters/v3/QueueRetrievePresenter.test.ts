import { describe, expect, it } from "vitest";
import { slotHolderConsistency } from "./QueueRetrievePresenter.server";

describe("slotHolderConsistency", () => {
  it("treats every non-final status as legitimately holding a slot", () => {
    // PENDING included: Redis membership is written at admission, before the run's
    // Postgres status moves on.
    for (const status of [
      "PENDING",
      "PENDING_VERSION",
      "WAITING_FOR_DEPLOY",
      "DEQUEUED",
      "EXECUTING",
      "WAITING_TO_RESUME",
      "RETRYING_AFTER_FAILURE",
      "PAUSED",
    ] as const) {
      expect(slotHolderConsistency({ status }, false)).toBe("consistent");
    }
  });

  it("flags final and not-yet-queued statuses as a mismatch", () => {
    for (const status of [
      "DELAYED",
      "CANCELED",
      "INTERRUPTED",
      "COMPLETED_SUCCESSFULLY",
      "COMPLETED_WITH_ERRORS",
      "SYSTEM_FAILURE",
      "CRASHED",
      "EXPIRED",
      "TIMED_OUT",
    ] as const) {
      expect(slotHolderConsistency({ status }, false)).toBe("mismatch");
    }
  });

  it("flags a holder with no run row as a mismatch", () => {
    expect(slotHolderConsistency(undefined, false)).toBe("mismatch");
  });

  it("reports unresolved when the lookup failed", () => {
    expect(slotHolderConsistency(undefined, true)).toBe("unresolved");
    expect(slotHolderConsistency({ status: "EXECUTING" }, true)).toBe("unresolved");
  });
});
