import { describe, expect, it } from "vitest";
import {
  apiKeyExpiryDay,
  apiKeyExpiryDayLabel,
  apiKeyExpiryEndDay,
  apiKeyExpiryTimestamp,
  DEFAULT_API_KEY_EXPIRY_DAYS,
  isApiKeyExpiryDayExpired,
} from "../app/utils/apiKeyExpiry";

describe("API key expiry", () => {
  // Catches: local today being offered after its UTC cutoff, and presets anchored to the wrong day.
  it.each(["America/Los_Angeles", "Asia/Tokyo", "UTC"])(
    "advances the selectable day and preset dates at UTC midnight in %s",
    (timezone) => {
      const previousTimezone = process.env.TZ;
      process.env.TZ = timezone;
      try {
        const beforeMidnight = new Date("2026-11-02T23:59:59Z");
        const afterMidnight = new Date("2026-11-03T02:00:00Z");
        const oldDay = apiKeyExpiryDay(beforeMidnight);
        const currentDay = apiKeyExpiryDay(afterMidnight);

        expect(isApiKeyExpiryDayExpired(oldDay, beforeMidnight)).toBe(false);
        expect(isApiKeyExpiryDayExpired(oldDay, afterMidnight)).toBe(true);
        expect(isApiKeyExpiryDayExpired(currentDay, afterMidnight)).toBe(false);
        expect([currentDay.getFullYear(), currentDay.getMonth(), currentDay.getDate()]).toEqual([
          2026, 10, 3,
        ]);
        expect(apiKeyExpiryTimestamp(currentDay).toISOString()).toBe("2026-11-04T00:00:00.000Z");
        expect(
          apiKeyExpiryTimestamp(
            apiKeyExpiryDay(beforeMidnight, DEFAULT_API_KEY_EXPIRY_DAYS)
          ).toISOString()
        ).toBe("2027-02-01T00:00:00.000Z");
        expect(
          apiKeyExpiryTimestamp(
            apiKeyExpiryDay(afterMidnight, DEFAULT_API_KEY_EXPIRY_DAYS)
          ).toISOString()
        ).toBe("2027-02-02T00:00:00.000Z");
      } finally {
        if (previousTimezone === undefined) delete process.env.TZ;
        else process.env.TZ = previousTimezone;
      }
    }
  );

  // Catches: an expiry at the end of 7 Feb showing as 8 Feb at midnight.
  it("labels a stored expiry with the day it ends on", () => {
    expect(apiKeyExpiryDayLabel(new Date("2027-02-08T00:00:00.000Z"))).toBe(
      "7 Feb 2027 (end of day, UTC)"
    );
    expect(apiKeyExpiryEndDay("2027-02-08T00:00:00.000Z")).toBe("7 Feb 2027");
    expect(apiKeyExpiryDayLabel("2027-02-08T12:30:00.000Z")).toBeUndefined();
  });
});
