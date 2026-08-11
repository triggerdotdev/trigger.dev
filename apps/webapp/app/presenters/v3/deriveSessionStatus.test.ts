import { describe, expect, it } from "vitest";
import { deriveSessionStatus } from "./deriveSessionStatus";

const NOW = new Date("2026-08-06T12:00:00.000Z").getTime();
const PAST = new Date("2026-08-01T00:00:00.000Z");
const FUTURE = new Date("2026-08-10T00:00:00.000Z");

describe("deriveSessionStatus", () => {
  it("returns CLOSED when closedAt is set, even with a live run", () => {
    expect(
      deriveSessionStatus({
        closedAt: PAST,
        expiresAt: null,
        hasCurrentRun: true,
        currentRunStatus: "EXECUTING",
        now: NOW,
      })
    ).toBe("CLOSED");
  });

  it("prefers CLOSED over an elapsed expiresAt", () => {
    expect(
      deriveSessionStatus({
        closedAt: PAST,
        expiresAt: PAST,
        hasCurrentRun: false,
        currentRunStatus: undefined,
        now: NOW,
      })
    ).toBe("CLOSED");
  });

  it("returns EXPIRED when expiresAt is in the past", () => {
    expect(
      deriveSessionStatus({
        closedAt: null,
        expiresAt: PAST,
        hasCurrentRun: true,
        currentRunStatus: "EXECUTING",
        now: NOW,
      })
    ).toBe("EXPIRED");
  });

  it("returns ACTIVE when the current run is non-final", () => {
    expect(
      deriveSessionStatus({
        closedAt: null,
        expiresAt: FUTURE,
        hasCurrentRun: true,
        currentRunStatus: "EXECUTING",
        now: NOW,
      })
    ).toBe("ACTIVE");
  });

  it("returns IDLE when the current run has reached a terminal state", () => {
    expect(
      deriveSessionStatus({
        closedAt: null,
        expiresAt: null,
        hasCurrentRun: true,
        currentRunStatus: "EXPIRED",
        now: NOW,
      })
    ).toBe("IDLE");
  });

  it("returns IDLE when there is no current run", () => {
    expect(
      deriveSessionStatus({
        closedAt: null,
        expiresAt: null,
        hasCurrentRun: false,
        currentRunStatus: undefined,
        now: NOW,
      })
    ).toBe("IDLE");
  });

  it("returns IDLE when the current run pointer can't be resolved (status unknown)", () => {
    expect(
      deriveSessionStatus({
        closedAt: null,
        expiresAt: null,
        hasCurrentRun: true,
        currentRunStatus: undefined,
        now: NOW,
      })
    ).toBe("IDLE");
  });
});
