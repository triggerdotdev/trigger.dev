import { describe, expect, it } from "vitest";
import { explicitWindowBelowMinimum } from "../app/v3/explicitWindowBelowMinimum";

describe("explicitWindowBelowMinimum", () => {
  it.each([
    ["0 * * * *", "50%", true],
    ["0 */2 * * *", "50%", false],
    ["0 9 * * 1", "1%", false],
    ["0 9 1 * *", "1%", false],
    ["0 0,8,16,17 * * *", "20%", true],
    ["0 * * * *", "30m", true],
    ["0 * * * *", "2h", false],
  ])("checks %s with window %s", (cron, explicitWindow, expected) => {
    expect(
      explicitWindowBelowMinimum({
        cron,
        explicitWindow,
        minimumWindowDurationSeconds: 3600,
        referenceTime: new Date("2026-01-01T17:01:00Z"),
      })
    ).toBe(expected);
  });
});
