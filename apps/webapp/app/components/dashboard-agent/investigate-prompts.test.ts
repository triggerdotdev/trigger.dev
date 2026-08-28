import { describe, expect, it } from "vitest";
import {
  errorGroupPrompt,
  failedRunPrompt,
  isFailedRunStatus,
  queueBacklogPrompt,
  waitingRunPrompt,
} from "./investigate-prompts";

describe("isFailedRunStatus", () => {
  it("is true for failure statuses", () => {
    for (const status of [
      "COMPLETED_WITH_ERRORS",
      "CRASHED",
      "SYSTEM_FAILURE",
      "TIMED_OUT",
      "EXPIRED",
    ]) {
      expect(isFailedRunStatus(status)).toBe(true);
    }
  });

  it("is false for everything else", () => {
    for (const status of ["PENDING", "EXECUTING", "COMPLETED_SUCCESSFULLY", "CANCELED", "PAUSED"]) {
      expect(isFailedRunStatus(status)).toBe(false);
    }
  });
});

describe("investigate prompts", () => {
  it("names the run that failed", () => {
    expect(failedRunPrompt("run_abc")).toBe("Investigate run run_abc — why did it fail?");
  });

  it("names the queue a waiting run is stuck in, when known", () => {
    expect(waitingRunPrompt("run_abc", "emails")).toBe(
      "Why is run run_abc waiting to start in the emails queue?"
    );
    expect(waitingRunPrompt("run_abc")).toBe("Why is run run_abc waiting to start?");
  });

  it("names the error and its task, when known", () => {
    expect(errorGroupPrompt("error_abc", "send-email")).toBe(
      "Investigate error error_abc in send-email — what's causing it and is it still happening?"
    );
    expect(errorGroupPrompt("error_abc")).toBe(
      "Investigate error error_abc — what's causing it and is it still happening?"
    );
  });

  it("names the backed-up queue", () => {
    expect(queueBacklogPrompt("emails")).toBe(
      "Investigate the emails queue — why is it backed up?"
    );
  });
});
