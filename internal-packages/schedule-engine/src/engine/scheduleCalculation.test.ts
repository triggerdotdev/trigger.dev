import { calculateNextNominalTimestamp } from "./scheduleCalculation.js";

describe("calculateNextNominalTimestamp", () => {
  it("advances from the previous nominal tick instead of wall-clock time", () => {
    const next = calculateNextNominalTimestamp(
      "* * * * *",
      "UTC",
      new Date("2024-01-01T09:00:00.000Z")
    );

    expect(next).toEqual(new Date("2024-01-01T09:01:00.000Z"));
  });

  it("uses the 23-hour elapsed interval across spring DST", () => {
    const nominalAt = new Date("2026-03-08T05:00:00.000Z");
    const next = calculateNextNominalTimestamp("0 0 * * *", "America/New_York", nominalAt);

    expect(next).toEqual(new Date("2026-03-09T04:00:00.000Z"));
    expect(next.getTime() - nominalAt.getTime()).toBe(23 * 60 * 60 * 1_000);
  });

  it("uses the 25-hour elapsed interval across autumn DST", () => {
    const nominalAt = new Date("2026-11-01T04:00:00.000Z");
    const next = calculateNextNominalTimestamp("0 0 * * *", "America/New_York", nominalAt);

    expect(next).toEqual(new Date("2026-11-02T05:00:00.000Z"));
    expect(next.getTime() - nominalAt.getTime()).toBe(25 * 60 * 60 * 1_000);
  });

  it("preserves cron-parser calendar semantics across month boundaries", () => {
    const next = calculateNextNominalTimestamp(
      "0 23 L * *",
      "UTC",
      new Date("2027-01-31T23:00:00.000Z")
    );

    expect(next).toEqual(new Date("2027-02-28T23:00:00.000Z"));
  });
});
