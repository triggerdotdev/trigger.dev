import { describe, expect, it } from "vitest";
import { isSessionLive } from "./isSessionLive";

describe("isSessionLive", () => {
  it("is live when the current run is executing", () => {
    expect(isSessionLive({ hasCurrentRun: true, currentRunStatus: "EXECUTING" })).toBe(true);
  });

  it("treats any non-final run status as live", () => {
    expect(isSessionLive({ hasCurrentRun: true, currentRunStatus: "PENDING" })).toBe(true);
  });

  it("is not live when the current run has reached a terminal state", () => {
    expect(isSessionLive({ hasCurrentRun: true, currentRunStatus: "EXPIRED" })).toBe(false);
  });

  it("is not live when there is no current run", () => {
    expect(isSessionLive({ hasCurrentRun: false, currentRunStatus: undefined })).toBe(false);
  });

  it("is not live when the current run pointer can't be resolved (status unknown)", () => {
    expect(isSessionLive({ hasCurrentRun: true, currentRunStatus: undefined })).toBe(false);
  });
});
