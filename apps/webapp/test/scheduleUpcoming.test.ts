import { parseExpression } from "cron-parser";
import { describe, expect, it } from "vitest";
import { pickCalendarDay } from "~/components/schedules/scheduleTime";
import { calculateScheduleCalendar } from "~/v3/scheduleUpcoming.server";

const runTiming = (nominalAt: Date) => ({
  nominalAt,
  effectiveAt: nominalAt,
  rangeEndAt: nominalAt,
});

function isDense(cron: string, timezone: string | null = null) {
  return calculateScheduleCalendar({
    cron,
    timezone,
    runTiming,
    active: true,
    now: new Date("2026-11-19T06:00:00Z"),
  })?.dense;
}

describe("which schedules are dense", () => {
  // Catches: a schedule where the day matters (weekdays only, business hours, twice a day)
  // losing its calendar, or an around-the-clock one keeping a month of identical days.
  it("is every day with no more than six hours between runs", () => {
    expect(isDense("* * * * *")).toBe(true);
    expect(isDense("*/15 * * * *", "Europe/London")).toBe(true);
    expect(isDense("0 * * * *")).toBe(true);
    expect(isDense("0 */6 * * *", "America/New_York")).toBe(true);

    expect(isDense("0 */8 * * *")).toBe(false);
    expect(isDense("0 9-17 * * *")).toBe(false);
    expect(isDense("*/5 * * * 1-5")).toBe(false);
    expect(isDense("30 2 * * *")).toBe(false);
    expect(isDense("0 9 1 * *")).toBe(false);
  });
});

describe("picking a day from the days already loaded", () => {
  const now = new Date("2026-11-19T18:30:00Z");
  // A 90 second window delay, so starts differ from cron times.
  const delayed = (nominalAt: Date) => ({
    nominalAt,
    effectiveAt: new Date(nominalAt.getTime() + 90_500),
    rangeEndAt: new Date(nominalAt.getTime() + 600_000),
  });
  const calendarFor = (cron: string, timezone: string, extra: { day?: string; month?: string }) =>
    calculateScheduleCalendar({ cron, timezone, runTiming: delayed, active: true, now, ...extra });
  /** Starts to the second: the loaded days keep whole seconds, and the day's table shows no more. */
  const seconds = (selected: NonNullable<ReturnType<typeof calendarFor>>["selected"]) =>
    selected && {
      ...selected,
      runs: selected.runs.map(([cronAt, startAt]) => [cronAt, Math.floor(startAt / 1000)]),
    };

  // Catches: the day worked out in the browser (no request) listing other runs, or stepping to
  // other days, than the loader gives for the same `?day=`.
  it("matches what the loader gives for that day", () => {
    const cases: Array<
      [cron: string, timezone: string, month: string | undefined, days: string[]]
    > = [
      // Today (runs left), a weekend day, the day after it, the last day drawn with runs.
      [
        "0 9-17 * * 1-5",
        "America/Los_Angeles",
        undefined,
        ["2026-11-19", "2026-11-21", "2026-11-23", "2026-12-25"],
      ],
      ["*/15 * * * *", "Europe/London", undefined, ["2026-11-19", "2026-11-20", "2026-12-24"]],
      ["30 2 * * *", "Australia/Sydney", undefined, ["2026-11-20", "2026-12-01"]],
      // A month's page: its first days have their previous run before the days drawn.
      ["0 3 * * 2", "Asia/Tokyo", "2027-02", ["2027-02-01", "2027-02-02", "2027-02-10"]],
    ];
    for (const [cron, timezone, month, days] of cases) {
      const loaded = calendarFor(cron, timezone, { month });
      if (!loaded) throw new Error(`no calendar for ${cron}`);
      for (const day of days) {
        const picked = pickCalendarDay(loaded, day, timezone, now.getTime());
        expect(seconds(picked?.selected), `${cron} on ${day}`).toEqual(
          seconds(calendarFor(cron, timezone, { month, day })?.selected)
        );
        expect(picked?.selected, `${cron} on ${day}`).toBeDefined();
      }
    }
  });

  // Catches: a clock change day's runs read from the usual pattern, where times are skipped or
  // run twice and only the loader steps the cron.
  it("leaves a clock change day, and a day outside the days loaded, to the loader", () => {
    const march = calendarFor("30 2 * * *", "Europe/Berlin", { month: "2027-03" });
    if (!march) throw new Error("no calendar");
    expect(pickCalendarDay(march, "2027-03-28", "Europe/Berlin", now.getTime())).toBeUndefined();
    expect(pickCalendarDay(march, "2027-06-01", "Europe/Berlin", now.getTime())).toBeUndefined();
    expect(pickCalendarDay(march, "2027-03-27", "Europe/Berlin", now.getTime())).toBeDefined();
  });
});

describe("runs that wait in their window", () => {
  // Half an hour of window delay on every run.
  const halfHourLate = (nominalAt: Date) => ({
    nominalAt,
    effectiveAt: new Date(nominalAt.getTime() + 30 * 60_000),
    rangeEndAt: new Date(nominalAt.getTime() + 60 * 60_000),
  });

  // Catches: a run dropping out of Upcoming at its cron time although its window holds it back
  // and it hasn't started, and the tab opening on tomorrow while today's run is still to come.
  it("stay upcoming until they start", () => {
    const now = new Date("2026-11-19T09:05:00Z");
    const calendar = calculateScheduleCalendar({
      cron: "0 9 * * *",
      timezone: "UTC",
      runTiming: halfHourLate,
      active: true,
      now,
    });
    expect(calendar?.selected?.day).toBe("2026-11-19");
    expect(calendar?.selected?.runs).toEqual([
      [Date.parse("2026-11-19T09:00:00Z"), Date.parse("2026-11-19T09:30:00Z")],
    ]);

    // The same day picked in the browser lists the same run.
    const tomorrow = calculateScheduleCalendar({
      cron: "0 9 * * *",
      timezone: "UTC",
      runTiming: halfHourLate,
      active: true,
      day: "2026-11-20",
      now,
    });
    if (!tomorrow) throw new Error("no calendar");
    expect(tomorrow.selected?.previousDay).toBe("2026-11-19");
    expect(pickCalendarDay(tomorrow, "2026-11-19", "UTC", now.getTime())?.selected?.runs).toEqual(
      calendar?.selected?.runs
    );

    // Once it has started, the tab moves on.
    const later = calculateScheduleCalendar({
      cron: "0 9 * * *",
      timezone: "UTC",
      runTiming: halfHourLate,
      active: true,
      now: new Date("2026-11-19T09:31:00Z"),
    });
    expect(later?.selected?.day).toBe("2026-11-20");
  });
});

describe("a day with a clock change", () => {
  const now = new Date("2026-11-19T06:00:00Z");

  // Catches: stepping one cron iterator across the change, which adds a 3:30 AM run for the
  // skipped 2:30 AM that the scheduler (it works out each run from the one before) never creates.
  it("lists the runs the scheduler creates when clocks go forward", () => {
    const calendar = calculateScheduleCalendar({
      cron: "0,30 1,2 * * *",
      timezone: "America/New_York",
      runTiming,
      active: true,
      month: "2027-03",
      day: "2027-03-14",
      now,
    });
    expect(calendar?.selected?.runs.map(([cronAt]) => new Date(cronAt).toISOString())).toEqual([
      "2027-03-14T06:00:00.000Z",
      "2027-03-14T06:30:00.000Z",
      "2027-03-14T07:00:00.000Z",
    ]);
  });

  // Catches: a window that crosses the change read on the cron time's side of it, which puts the
  // start at 2:30 AM on a day that has no 2:30 AM.
  it("puts a start and a window end on the wall clock of their own side of the change", () => {
    const calendar = calculateScheduleCalendar({
      cron: "30 1 * * *",
      timezone: "Europe/Berlin",
      // Starts an hour after its cron time, with a two hour window.
      runTiming: (nominalAt: Date) => ({
        nominalAt,
        effectiveAt: new Date(nominalAt.getTime() + 3_600_000),
        rangeEndAt: new Date(nominalAt.getTime() + 7_200_000),
      }),
      active: true,
      month: "2027-03",
      now,
    });
    const day = calendar?.days.find((entry) => entry.date === "2027-03-28");
    // 1:30 AM, then 3:30 AM and 4:30 AM summer time (2 AM to 3 AM doesn't exist that day).
    expect(calendar?.patterns[day?.pattern ?? -1]).toEqual([[5_400, 12_600, 16_200]]);
  });
});

describe("a clock change day in any timezone", () => {
  const now = new Date("2026-11-19T06:00:00Z");
  const HOUR = 3_600_000;

  /** The day's runs from stepping the cron the scheduler's way: each from the one before. */
  function steppedRuns(cron: string, timezone: string, date: string) {
    const dateOf = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    const midnightUtc = new Date(`${date}T00:00:00Z`).getTime();
    const end = midnightUtc + 40 * HOUR;
    const runs: number[] = [];
    let cursor = midnightUtc - 16 * HOUR;
    for (let steps = 0; steps < 2_000; steps++) {
      const next = parseExpression(cron, { tz: timezone, currentDate: new Date(cursor) })
        .next()
        .toDate()
        .getTime();
      if (next > end) break;
      if (dateOf.format(next) === date) runs.push(next);
      cursor = next;
    }
    return runs;
  }

  // Clocks forward and back: by an hour at 2 AM, at 1 AM and at midnight, by half an hour, and
  // by two hours.
  const changeDays: Array<[timezone: string, dates: string[]]> = [
    ["America/New_York", ["2027-03-14", "2027-11-07"]],
    ["Europe/London", ["2027-03-28", "2027-10-31"]],
    ["America/Havana", ["2027-03-14", "2027-11-07"]],
    ["Australia/Lord_Howe", ["2027-04-04", "2027-10-03"]],
    ["Antarctica/Troll", ["2027-03-28", "2027-10-31"]],
    ["Africa/Cairo", ["2027-04-30", "2027-10-28"]],
  ];
  const crons = [
    "*/10 0-4 * * *",
    "30 * * * *",
    "0,30 1,2 * * *",
    "59 2 * * *",
    "0 0,1 * * *",
    "15 23,0 * * *",
    // Only on the day of the week the clocks change: a day that starts twice, or late.
    "10 * * * 0",
    "5 0,1 * * 4,5",
  ];

  // Catches: the runs near a clock change read from the cron's fields where the scheduler runs
  // something else (a time skipped, moved or run once), or stepped from the wrong starting run.
  it.each(changeDays)("lists the runs the scheduler creates in %s", (timezone, dates) => {
    for (const date of dates) {
      for (const cron of crons) {
        const calendar = calculateScheduleCalendar({
          cron,
          timezone,
          runTiming,
          active: true,
          month: date.slice(0, 7),
          day: date,
          now,
        });
        expect(
          calendar?.selected?.runs.map(([cronAt]) => new Date(cronAt).toISOString()),
          `${cron} on ${date}`
        ).toEqual(steppedRuns(cron, timezone, date).map((run) => new Date(run).toISOString()));
      }
    }
  });
});

describe("a picked day outside the days drawn", () => {
  const now = new Date("2026-11-19T06:00:00Z");
  const pick = (cron: string, extra: { day?: string; month?: string }) =>
    calculateScheduleCalendar({
      cron,
      timezone: "America/New_York",
      runTiming,
      active: true,
      now,
      ...extra,
    });
  const cronTimes = (calendar: ReturnType<typeof pick>) =>
    calendar?.selected?.runs.map(([cronAt]) => new Date(cronAt).toISOString());

  // Catches: a day picked from another month than the one drawn read with the day before's
  // offset, which is an hour off on the day the clocks change.
  it("gets that day's clock change, a year and more ahead", () => {
    const alone = pick("0 9 * * *", { day: "2028-03-12" });
    // 9 AM on the day clocks go forward is 13:00 UTC, not the winter 14:00.
    expect(cronTimes(alone)).toEqual(["2028-03-12T13:00:00.000Z"]);
    expect(alone?.selected).toEqual(
      pick("0 9 * * *", { month: "2028-03", day: "2028-03-12" })?.selected
    );
    expect(alone?.clockChanges.map((change) => change.at.toISOString())).toContain(
      "2028-03-12T07:00:00.000Z"
    );
  });

  it("gets that day's clock change when it is before the days drawn", () => {
    // 2:30 AM doesn't exist on 2027-03-14: the scheduler runs it at 3:30 AM summer time.
    const alone = pick("30 2 * * *", { month: "2027-06", day: "2027-03-14" });
    expect(cronTimes(alone)).toEqual(["2027-03-14T07:30:00.000Z"]);
    expect(alone?.selected).toEqual(
      pick("30 2 * * *", { month: "2027-03", day: "2027-03-14" })?.selected
    );
    expect(alone?.clockChanges.find((change) => change.moved.length > 0)?.moved).toEqual([
      { cronTime: "02:30", at: new Date("2027-03-14T07:30:00.000Z") },
    ]);
  });

  // Catches: any `day` in the URL worked out, however far off or impossible.
  it("ignores a day past the calendar's last month and a day that isn't a date", () => {
    const opensOn = pick("0 9 * * *", {})?.selected?.day;
    expect(opensOn).toBe("2026-11-19");
    for (const day of ["9999-12-31", "2032-12-01", "2027-02-31"]) {
      expect(pick("0 9 * * *", { day })?.selected?.day, day).toBe(opensOn);
    }
    // The last day a year view of the last month draws is still a day to pick.
    expect(pick("0 9 * * *", { day: "2032-10-31" })?.selected?.day).toBe("2032-10-31");
  });
});

describe("the day Upcoming opens on, on a clock change day", () => {
  const halfHourLate = (nominalAt: Date) => ({
    nominalAt,
    effectiveAt: new Date(nominalAt.getTime() + 30 * 60_000),
    rangeEndAt: new Date(nominalAt.getTime() + 60 * 60_000),
  });
  const opensOn = (cron: string, now: string) =>
    calculateScheduleCalendar({
      cron,
      timezone: "America/New_York",
      runTiming: halfHourLate,
      active: true,
      now: new Date(now),
    })?.selected;

  // Catches: looking for a waiting run by stepping the cron back, which finds the second 1:30 AM
  // of the day clocks go back (the scheduler runs 1:30 AM once) and opens on a day with no runs.
  it("is the next day once the only 1:30 AM has run, when clocks go back", () => {
    expect(opensOn("30 1 * * *", "2027-11-07T06:35:00Z")?.day).toBe("2027-11-08");
  });

  // Catches: the same step back missing the 2:30 AM run that moved to 3:30 AM when clocks go
  // forward, and skipping to the day after while that run is still waiting.
  it("is today while the run moved out of the skipped hour is waiting", () => {
    const selected = opensOn("30 2 * * *", "2027-03-14T07:35:00Z");
    expect(selected?.day).toBe("2027-03-14");
    expect(selected?.runs).toEqual([
      [Date.parse("2027-03-14T07:30:00Z"), Date.parse("2027-03-14T08:00:00Z")],
    ]);
  });
});

describe("cron expressions whose days aren't in their fields alone", () => {
  // Catches: the second Monday of the month (`1#2`) read as every Monday.
  it("keep the nth weekday of the month", () => {
    const calendar = calculateScheduleCalendar({
      cron: "0 9 * * 1#2",
      timezone: "UTC",
      runTiming,
      active: true,
      view: "month",
      month: "2026-12",
      now: new Date("2026-11-19T06:00:00Z"),
    });
    const december = calendar?.days.filter(
      (day) => day.date.startsWith("2026-12") && day.pattern !== null
    );
    expect(december?.map((day) => day.date)).toEqual(["2026-12-14"]);
  });
});

describe("predefined cron expressions", () => {
  // Catches: `@daily` (it has no fields to read the days from) showing no upcoming runs.
  it("get a calendar", () => {
    const calendar = calculateScheduleCalendar({
      cron: "@daily",
      timezone: "UTC",
      runTiming,
      active: true,
      now: new Date("2026-11-19T06:00:00Z"),
    });
    expect(calendar?.selected?.day).toBe("2026-11-20");
    expect(calendar?.days.every((day) => day.pattern !== null)).toBe(true);
  });
});
