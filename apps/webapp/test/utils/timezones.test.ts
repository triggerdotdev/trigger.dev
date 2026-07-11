import { describe, expect, it } from "vitest";
import { isValidTimeZone } from "~/utils/timezones.server";

describe("isValidTimeZone", () => {
  // These are all zones a browser can report via
  // Intl.DateTimeFormat().resolvedOptions().timeZone, but which are NOT in
  // Intl.supportedValuesOf("timeZone"). Rejecting them left the user's stored
  // timezone stale (their preference update would 400).
  it.each(["UTC", "Etc/UTC", "GMT", "Asia/Kolkata"])(
    "accepts %s even though it is not in supportedValuesOf",
    (tz) => {
      expect(Intl.supportedValuesOf("timeZone").includes(tz)).toBe(false);
      expect(isValidTimeZone(tz)).toBe(true);
    }
  );

  it.each(["Europe/London", "Europe/Moscow", "America/New_York", "Asia/Calcutta"])(
    "accepts canonical zone %s",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(true);
    }
  );

  it.each(["", "Not/AZone", "Mars/Phobos", "Europe/Nowhere", "12345"])(
    "rejects invalid zone %s",
    (tz) => {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  );
});
