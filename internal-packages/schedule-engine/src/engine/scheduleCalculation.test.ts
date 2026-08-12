import {
  calculateNextNominalTimestamp,
  calculateNextSchedulableOccurrence,
  nextScheduledTimestamps,
} from "./scheduleCalculation.js";
import { SCHEDULE_PHASE_DENOMINATOR } from "./scheduleTiming.js";

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

describe("calculateNextSchedulableOccurrence", () => {
  const hourlySchedule = "0 * * * *";
  const window = { type: "percentage", percentage: 100 } as const;

  it("restores wall-clock catch-up behavior when spreading is disabled", () => {
    const occurrence = calculateNextSchedulableOccurrence({
      schedule: hourlySchedule,
      timezone: "UTC",
      afterNominal: new Date("2026-08-11T09:00:00.000Z"),
      now: new Date("2026-08-11T12:30:00.000Z"),
      schedulePhase: (SCHEDULE_PHASE_DENOMINATOR * 3) / 4,
      window,
      cronSpreadEnabled: false,
    });

    expect(occurrence.nominalAt).toEqual(new Date("2026-08-11T13:00:00.000Z"));
    expect(occurrence.effectiveAt).toEqual(occurrence.nominalAt);
    expect(occurrence.skippedExpiredOccurrences).toBe(true);
  });

  it("keeps strict nominal chaining when the next effective time is upcoming", () => {
    const occurrence = calculateNextSchedulableOccurrence({
      schedule: hourlySchedule,
      timezone: "UTC",
      afterNominal: new Date("2026-08-11T09:00:00.000Z"),
      now: new Date("2026-08-11T10:00:01.000Z"),
      schedulePhase: (SCHEDULE_PHASE_DENOMINATOR * 3) / 4,
      window,
      cronSpreadEnabled: true,
    });

    expect(occurrence.nominalAt).toEqual(new Date("2026-08-11T10:00:00.000Z"));
    expect(occurrence.effectiveAt).toEqual(new Date("2026-08-11T10:45:00.000Z"));
    expect(occurrence.skippedExpiredOccurrences).toBe(false);
  });

  it("keeps the latest nominal occurrence when its effective time is upcoming", () => {
    const occurrence = calculateNextSchedulableOccurrence({
      schedule: hourlySchedule,
      timezone: "UTC",
      afterNominal: new Date("2026-08-11T09:00:00.000Z"),
      now: new Date("2026-08-11T12:30:00.000Z"),
      schedulePhase: (SCHEDULE_PHASE_DENOMINATOR * 3) / 4,
      window,
      cronSpreadEnabled: true,
    });

    expect(occurrence.nominalAt).toEqual(new Date("2026-08-11T12:00:00.000Z"));
    expect(occurrence.effectiveAt).toEqual(new Date("2026-08-11T12:45:00.000Z"));
    expect(occurrence.skippedExpiredOccurrences).toBe(true);
  });

  it("skips to the next future nominal occurrence when the latest effective time expired", () => {
    const occurrence = calculateNextSchedulableOccurrence({
      schedule: hourlySchedule,
      timezone: "UTC",
      afterNominal: new Date("2026-08-11T09:00:00.000Z"),
      now: new Date("2026-08-11T12:30:00.000Z"),
      schedulePhase: SCHEDULE_PHASE_DENOMINATOR / 4,
      window,
      cronSpreadEnabled: true,
    });

    expect(occurrence.nominalAt).toEqual(new Date("2026-08-11T13:00:00.000Z"));
    expect(occurrence.effectiveAt).toEqual(new Date("2026-08-11T13:15:00.000Z"));
    expect(occurrence.skippedExpiredOccurrences).toBe(true);
  });

  it("includes a nominal occurrence exactly at now when it is still eligible", () => {
    const occurrence = calculateNextSchedulableOccurrence({
      schedule: hourlySchedule,
      timezone: "UTC",
      afterNominal: new Date("2026-08-11T09:00:00.000Z"),
      now: new Date("2026-08-11T12:00:00.000Z"),
      schedulePhase: 0,
      window,
      cronSpreadEnabled: true,
    });

    expect(occurrence.nominalAt).toEqual(new Date("2026-08-11T12:00:00.000Z"));
    expect(occurrence.effectiveAt).toEqual(new Date("2026-08-11T12:00:00.000Z"));
  });
});

describe("nextScheduledTimestamps", () => {
  it("advances every timestamp from the preceding nominal tick", () => {
    const upcoming = nextScheduledTimestamps(
      "* * * * *",
      "UTC",
      new Date("2024-01-01T09:00:00.000Z"),
      3
    );

    expect(upcoming).toEqual([
      new Date("2024-01-01T09:01:00.000Z"),
      new Date("2024-01-01T09:02:00.000Z"),
      new Date("2024-01-01T09:03:00.000Z"),
    ]);
  });
});
