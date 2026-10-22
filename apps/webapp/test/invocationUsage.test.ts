import { describe, expect, it } from "vitest";
import { shouldReportAttemptInvocation } from "~/v3/invocationUsage.server";

describe("shouldReportAttemptInvocation", () => {
  it("reports the first attempt", () => {
    expect(shouldReportAttemptInvocation({ attemptNumber: 1 })).toBe(true);
  });

  it("reports the first attempt of a run with no base cost", () => {
    const run = { attemptNumber: 1, baseCostInCents: 0 };

    expect(shouldReportAttemptInvocation(run)).toBe(true);
  });

  it("skips retries", () => {
    expect(shouldReportAttemptInvocation({ attemptNumber: 2 })).toBe(false);
  });
});
