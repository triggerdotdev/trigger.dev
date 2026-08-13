import { describe, expect, it } from "vitest";
import { formatDeclarativeScheduleOutput } from "./schedules.js";

describe("declarative schedule deploy output", () => {
  it("formats assigned times and explicit windows", () => {
    expect(
      formatDeclarativeScheduleOutput([
        {
          task: "daily-report",
          cron: "0 9 * * *",
          timezone: "Europe/London",
          window: "30m",
          nextRun: new Date("2026-08-12T08:00:00.000Z"),
          nextRunEffectiveAt: new Date("2026-08-12T08:17:45.000Z"),
        },
      ])
    ).toEqual([
      "Declarative schedules",
      "  daily-report: 0 9 * * * (Europe/London) | window 30m | 2026-08-12 08:00:00 UTC -> 2026-08-12 08:17:45 UTC",
    ]);
  });

  it("reports that an assigned time is pending registration", () => {
    expect(
      formatDeclarativeScheduleOutput([
        {
          task: "daily-report",
          cron: "0 9 * * *",
          timezone: "UTC",
          nextRun: new Date("2026-08-12T09:00:00.000Z"),
          nextRunEffectiveAt: null,
        },
      ])
    ).toContain(
      "  daily-report: 0 9 * * * (UTC) | window default 60s | next nominal 2026-08-12 09:00:00 UTC | next assigned time pending registration"
    );
  });

  it("nudges schedules using the default window", () => {
    const lines = formatDeclarativeScheduleOutput([
      {
        task: "hourly-report",
        cron: "0 * * * *",
        timezone: "UTC",
        nextRun: new Date("2026-08-12T09:00:00.000Z"),
        nextRunEffectiveAt: new Date("2026-08-12T09:00:21.000Z"),
      },
    ]);

    expect(lines).toContain(
      'Tip: 1 declarative schedule uses the default 60-second placement range. Add window: "30m" to the cron object to spread starts over a wider range.'
    );
  });

  it("returns no output when there are no declarative schedules", () => {
    expect(formatDeclarativeScheduleOutput([])).toEqual([]);
  });
});
