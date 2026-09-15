import { EnvironmentPauseSource } from "@trigger.dev/database";
import { describe, expect, it } from "vitest";
import { getManualPauseEnvironmentResult } from "~/v3/services/billingLimit/manualPauseEnvironmentGuard.server";

describe("manualPauseEnvironmentGuard", () => {
  it("blocks resume and no-ops pause for billing-paused environments", () => {
    expect(
      getManualPauseEnvironmentResult("resumed", EnvironmentPauseSource.BILLING_LIMIT)
    ).toEqual({
      proceed: false,
      success: false,
      error: expect.stringContaining("billing limit"),
    });

    expect(getManualPauseEnvironmentResult("paused", EnvironmentPauseSource.BILLING_LIMIT)).toEqual(
      {
        proceed: false,
        success: true,
        state: "paused",
      }
    );

    expect(getManualPauseEnvironmentResult("resumed", null)).toEqual({ proceed: true });
    expect(getManualPauseEnvironmentResult("paused", null)).toEqual({ proceed: true });
  });
});
