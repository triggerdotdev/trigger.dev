import { parseExpression } from "cron-parser";
import { calculateScheduleDays, type ScheduleRunTiming } from "./scheduleWindow.server";

/*
 * Data for the Upcoming tab on a schedule's page: a calendar of the days it runs (a month, or a
 * year of months), what each day's runs look like, one day's runs in full, and what the cron does
 * around a daylight saving change.
 *
 * Stepping a timezone cron costs about a millisecond a run, and a month of an every-five-minute
 * cron is twelve thousand runs, so nothing here steps the cron through its runs. A day's runs come
 * from the cron's hour and minute fields mapped through the timezone, and days with the same runs
 * share one pattern. The cron is only stepped where the fields don't tell the whole story: the
 * hour a clock change skips or repeats, and one step either side of the selected day.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** The most runs listed for one day. */
const MAX_DAY_RUNS = 400;
/** The most cron steps taken around a clock change (far more than an every-minute cron needs). */
const MAX_CHANGE_RUNS = 400;
/** How far ahead the calendar goes, in months. */
const HORIZON_MONTHS = 60;
/** How far before a clock change the stepping around it looks for the run to start from. */
const CHANGE_LOOKBACK = 3 * HOUR;
/** A schedule that runs every day and never waits longer than this between runs is dense. */
const DENSE_GAP_MINUTES = 6 * 60;

/** A run's timing from its cron time and the next cron time (the presenter's `runTiming`). */
export type RunTiming = (nominalAt: Date, nextNominalAt: Date) => ScheduleRunTiming;

export type ScheduleClockChange = {
  /** The instant the offset changes. */
  at: Date;
  /** Positive when clocks go forward. */
  deltaMinutes: number;
  /**
   * What the change does to this cron, worked out only for changes on a day the calendar shows:
   * cron times that don't exist that day and are dropped (local "HH:MM").
   */
  skipped: string[];
  /** Cron times that don't exist that day and run later instead. */
  moved: Array<{ cronTime: string; at: Date }>;
  /** Cron times that happen twice that day and run both times. */
  repeated: string[];
  /** Cron times that happen twice that day but run once, the first time. */
  once: string[];
};

/**
 * A run on a calendar day, in seconds into that day on the schedule's wall clock: its cron time,
 * when it starts (later than the cron time with a window), and the end of its window.
 */
export type ScheduleDayRun = [cron: number, start: number, end: number];

export type ScheduleCalendarView = "month" | "year";

export type ScheduleCalendar = {
  view: ScheduleCalendarView;
  /**
   * It runs every day, around the clock (every minute up to every six hours): no day differs from
   * the next, so the tab shows its rhythm instead of a calendar.
   */
  dense: boolean;
  /**
   * The month shown ("2027-03"), or the first of the twelve in the year view. Undefined on the
   * default view, which starts from this week (or this month, in the year view).
   */
  month: string | undefined;
  /** The days drawn, in order; `pattern` indexes `patterns`, null on a day with no runs. */
  days: Array<{ date: string; pattern: number | null }>;
  /** The distinct sets of runs a day has. Most schedules have one or two. */
  patterns: ScheduleDayRun[][];
  /**
   * Daylight saving changes in the year from the first day drawn, and the one on the selected day
   * when that day is outside them.
   */
  clockChanges: ScheduleClockChange[];
  /**
   * The nearest days with runs still to come either side of the days drawn, so the browser can
   * step from a day at their edge without asking for it.
   */
  runsBefore?: string;
  runsAfter?: string;
  selected:
    | {
        day: string;
        /** The day's runs still to come: each one's cron time and when it starts, in epoch ms. */
        runs: Array<[cronAt: number, startAt: number]>;
        /** More runs fall on the day than are listed. */
        truncated: boolean;
        /** The nearest days with runs either side, for stepping through them. */
        previousDay: string | undefined;
        nextDay: string | undefined;
      }
    | undefined;
};

const offsetFormatters = new Map<string, Intl.DateTimeFormat>();
const dateFormatters = new Map<string, Intl.DateTimeFormat>();

/** The timezone's offset from UTC in minutes at `date`. */
function zoneOffsetMinutes(date: Date | number, timeZone: string) {
  let formatter = offsetFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
    offsetFormatters.set(timeZone, formatter);
  }
  const name = formatter.formatToParts(date).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = name.match(/([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** "2026-11-19": the calendar date of `date` in `timeZone`. */
function dateInZone(date: Date | number, timeZone: string) {
  let formatter = dateFormatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    });
    dateFormatters.set(timeZone, formatter);
  }
  return formatter.format(date);
}

/** A calendar date as the UTC instant of its wall-clock midnight, for date arithmetic. */
function wallMidnight(date: string) {
  return new Date(`${date}T00:00:00Z`).getTime();
}

function shiftDate(date: string, days: number) {
  return new Date(wallMidnight(date) + days * DAY).toISOString().slice(0, 10);
}

function shiftMonth(month: string, months: number) {
  const [year, index] = month.split("-").map(Number);
  return new Date(Date.UTC(year, index - 1 + months, 1)).toISOString().slice(0, 7);
}

/** The Monday on or before `date`. */
function mondayOnOrBefore(date: string) {
  const weekday = new Date(wallMidnight(date)).getUTCDay();
  return shiftDate(date, -((weekday + 6) % 7));
}

/** The UTC instant of local midnight on `date` in `timeZone`. */
function zonedMidnight(date: string, timeZone: string) {
  const wall = wallMidnight(date);
  let guess = wall - zoneOffsetMinutes(wall, timeZone) * MINUTE;
  guess = wall - zoneOffsetMinutes(guess, timeZone) * MINUTE;
  return guess;
}

function cronIterator(cron: string, timezone: string | null, from: number, to?: number) {
  return parseExpression(cron, {
    utc: timezone === null,
    tz: timezone ?? undefined,
    currentDate: new Date(from),
    endDate: to === undefined ? undefined : new Date(to),
  });
}

/** The first cron time after `instant`. */
function firstRunAfter(cron: string, timezone: string | null, instant: number) {
  try {
    return cronIterator(cron, timezone, instant).next().toDate().getTime();
  } catch {
    return undefined;
  }
}

/** The last cron time before `instant`. */
function lastRunBefore(cron: string, timezone: string | null, instant: number) {
  try {
    return cronIterator(cron, timezone, instant).prev().toDate().getTime();
  } catch {
    return undefined;
  }
}

/**
 * The last cron time at or before `instant` that the scheduler runs. Around a clock change,
 * stepping back doesn't always land on one (it can return the second 1:30 AM of a day the
 * scheduler runs 1:30 AM once, or miss a run that moved out of the skipped hour), so this goes two
 * cron times back and steps forward, the way the scheduler does.
 */
function lastScheduledRun(cron: string, timezone: string | null, instant: number) {
  const back = lastRunBefore(cron, timezone, instant + 1);
  if (back === undefined) return undefined;
  let cursor = (lastRunBefore(cron, timezone, back) ?? back) - 1;
  let last: number | undefined;
  // Two cron times back is at most a few steps from `instant`.
  for (let step = 0; step < 6; step++) {
    const next = firstRunAfter(cron, timezone, cursor);
    if (next === undefined || next > instant) break;
    last = next;
    cursor = next;
  }
  return last;
}

type OffsetChange = { at: number; before: number; after: number };

/** The instants the timezone's offset changes in the `days` days from `from`. */
function findOffsetChanges(timeZone: string, from: number, days: number): OffsetChange[] {
  const changes: OffsetChange[] = [];
  let previous = zoneOffsetMinutes(from, timeZone);
  for (let day = 1; day <= days; day++) {
    const probe = from + day * DAY;
    const offset = zoneOffsetMinutes(probe, timeZone);
    if (offset === previous) continue;
    let low = probe - DAY;
    let high = probe;
    while (high - low > MINUTE) {
      const mid = Math.floor((low + high) / 2);
      if (zoneOffsetMinutes(mid, timeZone) === previous) low = mid;
      else high = mid;
    }
    // The change happens on a minute boundary, the first one after `low`.
    changes.push({ at: Math.ceil((low + 1) / MINUTE) * MINUTE, before: previous, after: offset });
    previous = offset;
  }
  return changes;
}

/**
 * How long either side of a clock change the cron's fields can't be trusted: the length of the
 * change. The skipped hour's runs land in the stretch after it, and so does the second pass over a
 * repeated hour. Further from the change than this, a run is at its wall-clock time with that
 * side's offset.
 */
function changeSpan(change: OffsetChange) {
  return Math.abs(change.after - change.before) * MINUTE;
}

/**
 * Whether the stretch a clock change skips or repeats touches local midnight. The day then starts
 * twice or not at all, and the runs before the change can differ from the cron's fields too.
 */
function changeTouchesMidnight(change: OffsetChange) {
  const wallBefore = change.at + change.before * MINUTE;
  const wallAfter = change.at + change.after * MINUTE;
  const low = Math.min(wallBefore, wallAfter);
  const high = Math.max(wallBefore, wallAfter);
  return Math.floor((low - 1) / DAY) !== Math.floor(high / DAY);
}

/**
 * What the scheduler really runs around a clock change, from `changeSpan` before it to
 * `changeSpan` after it.
 *
 * From the change on, the runs are stepped the way the scheduler steps: each from the one before,
 * parsing the cron again every time. One iterator stepped across the change doesn't always agree
 * with that (it can add a run in the hour that was skipped), and neither does a first step from
 * just before the change, so the stepping starts from the last run before the stretch.
 *
 * Before the change the runs are the cron's wall-clock times, which cost a third as much to find,
 * unless the change touches midnight: then that stretch is stepped as well.
 */
function runsAroundChange(cron: string, timezone: string, change: OffsetChange) {
  const span = changeSpan(change);
  const wallOf = (instant: number) => instant + change.before * MINUTE;
  const instantOf = (wall: number) => wall - change.before * MINUTE;
  const steppedFrom = changeTouchesMidnight(change) ? change.at - span : change.at;
  const runs = cronWallTimes(cron, wallOf(change.at - span), wallOf(steppedFrom)).map(instantOf);
  const end = change.at + span - 1;
  try {
    const previous = lastWallTimeBefore(cron, wallOf(steppedFrom));
    let cursor =
      previous !== undefined && instantOf(previous) >= change.at - CHANGE_LOOKBACK
        ? instantOf(previous)
        : change.at - CHANGE_LOOKBACK - 1;
    for (let steps = 0; steps < MAX_CHANGE_RUNS; steps++) {
      const next = cronIterator(cron, timezone, cursor).next().toDate().getTime();
      if (next > end || next <= cursor) break;
      if (next >= steppedFrom) runs.push(next);
      cursor = next;
    }
  } catch {
    // An unparsable cron has no runs.
  }
  return runs;
}

function wallLabel(wallMs: number) {
  return new Date(wallMs).toISOString().slice(11, 16);
}

/** Wall-clock times the cron matches in [start, end), worked out on the wall clock itself. */
function cronWallTimes(cron: string, start: number, end: number) {
  const times: number[] = [];
  try {
    const iterator = parseExpression(cron, {
      utc: true,
      currentDate: new Date(start - 1),
      endDate: new Date(end - 1),
    });
    // `next` throws past `endDate`. Asking `hasNext` first would find every time twice.
    while (times.length < 120) times.push(iterator.next().toDate().getTime());
  } catch {
    // The end of the range, or an unparsable cron, which has no times.
  }
  return times;
}

/** The last wall-clock time the cron matches before `end`, worked out on the wall clock itself. */
function lastWallTimeBefore(cron: string, end: number) {
  try {
    return parseExpression(cron, { utc: true, currentDate: new Date(end) })
      .prev()
      .toDate()
      .getTime();
  } catch {
    return undefined;
  }
}

/**
 * `runs` are the runs around the change (`runsAroundChange`), or undefined when the cron's fields
 * say it all: every time in a skipped hour is skipped, every time in a repeated hour runs twice.
 */
function describeClockChange(
  cron: string,
  change: OffsetChange,
  runs: number[] | undefined
): ScheduleClockChange {
  const deltaMinutes = change.after - change.before;
  const described: ScheduleClockChange = {
    at: new Date(change.at),
    deltaMinutes,
    skipped: [],
    moved: [],
    repeated: [],
    once: [],
  };
  const wallOf = (run: number) => run + (run < change.at ? change.before : change.after) * MINUTE;

  if (deltaMinutes > 0) {
    // Clocks jump from `gapStart` to `gapStart + delta`: cron times in between don't exist.
    const gapStart = change.at + change.before * MINUTE;
    const missing = cronWallTimes(cron, gapStart, gapStart + deltaMinutes * MINUTE);
    const matchesCron = (wall: number) => cronWallTimes(cron, wall, wall + 1).length > 0;
    // A run whose wall time isn't a cron time stands in for one that didn't exist.
    const standIns = (runs ?? []).filter((run) => !matchesCron(wallOf(run)));
    missing.forEach((wall, index) => {
      const standIn = standIns[index];
      if (standIn !== undefined) {
        described.moved.push({ cronTime: wallLabel(wall), at: new Date(standIn) });
      } else described.skipped.push(wallLabel(wall));
    });
  } else {
    // Clocks go back over [repeatStart, repeatStart + |delta|): those wall times happen twice.
    const repeatStart = change.at + change.after * MINUTE;
    const doubled = cronWallTimes(cron, repeatStart, repeatStart - deltaMinutes * MINUTE);
    for (const wall of doubled) {
      const count = runs ? runs.filter((run) => wallOf(run) === wall).length : 2;
      if (count >= 2) described.repeated.push(wallLabel(wall));
      else if (count === 1) described.once.push(wallLabel(wall));
    }
  }
  return described;
}

/** The longest wait between a day's cron times, in minutes, the one over midnight included. */
function largestGapMinutes(hours: number[], minutes: number[]) {
  const times = hours
    .flatMap((hour) => minutes.map((minute) => hour * 60 + minute))
    .sort((a, b) => a - b);
  if (times.length === 0) return Infinity;
  let gap = times[0] + 24 * 60 - times[times.length - 1];
  for (let index = 1; index < times.length; index++) {
    gap = Math.max(gap, times[index] - times[index - 1]);
  }
  return gap;
}

const MONTH_PATTERN = /^\d{4}-(0[1-9]|1[0-2])$/;
const DAY_PATTERN = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;

/**
 * The calendar for a schedule's Upcoming tab.
 *
 * With no `month` the month view starts from this week and runs six weeks; with one it is that
 * calendar month's six weeks. The year view is twelve months from `month` (or this month). The
 * view defaults to a year when the schedule runs on fewer than four of the next 42 days, like a
 * monthly or quarterly one.
 */
export function calculateScheduleCalendar({
  cron,
  timezone,
  runTiming,
  active,
  month: requestedMonth,
  day: requestedDay,
  view: requestedView,
  now = new Date(),
}: {
  cron: string;
  timezone: string | null;
  runTiming: RunTiming;
  /** A disabled schedule shows when it would run, with no day picked. */
  active: boolean;
  month?: string | null;
  day?: string | null;
  view?: string | null;
  now?: Date;
}): ScheduleCalendar | undefined {
  const zone = timezone ?? "UTC";
  const nowMs = now.getTime();
  const today = dateInZone(nowMs, zone);
  const currentMonth = today.slice(0, 7);

  const ahead = calculateScheduleDays({ cron, timezone, from: now, dayCount: 42 });
  if (!ahead) return undefined;
  const sparse = ahead.days.filter((day) => day.fires).length < 4;
  const dense =
    ahead.days.every((day) => day.fires) &&
    largestGapMinutes(ahead.hours, ahead.minutes) <= DENSE_GAP_MINUTES;
  const view: ScheduleCalendarView =
    requestedView === "month" || requestedView === "year"
      ? requestedView
      : sparse
        ? "year"
        : "month";

  // Earlier months have nothing upcoming, and the calendar stops five years out.
  let month: string | undefined;
  if (requestedMonth && MONTH_PATTERN.test(requestedMonth) && requestedMonth > currentMonth) {
    const last = shiftMonth(currentMonth, HORIZON_MONTHS);
    month = requestedMonth > last ? last : requestedMonth;
  }

  // A picked day is a real date, today or later, no later than the last day the calendar draws
  // (a year view of its last month).
  const lastPickableDay = shiftDate(`${shiftMonth(currentMonth, HORIZON_MONTHS + 12)}-01`, -1);
  const pickedDay =
    requestedDay &&
    DAY_PATTERN.test(requestedDay) &&
    shiftDate(requestedDay, 0) === requestedDay &&
    requestedDay >= today &&
    requestedDay <= lastPickableDay
      ? requestedDay
      : undefined;

  const firstDate =
    view === "year"
      ? `${month ?? currentMonth}-01`
      : mondayOnOrBefore(month ? `${month}-01` : today);
  const dayCount =
    view === "year"
      ? Math.round(
          (wallMidnight(`${shiftMonth(firstDate.slice(0, 7), 12)}-01`) - wallMidnight(firstDate)) /
            DAY
        )
      : 42;

  // Local noon of the first day, so the day list starts on it in any timezone.
  const range = calculateScheduleDays({
    cron,
    timezone,
    from: new Date(zonedMidnight(firstDate, zone) + 12 * HOUR),
    dayCount,
  });
  if (!range) return undefined;
  const fires = new Map(range.days.map((day) => [day.date, day.fires] as const));
  /** The cron's times on a day it runs, in minutes into the day. */
  const times = range.hours
    .flatMap((hour) => range.minutes.map((minute) => hour * 60 + minute))
    .sort((a, b) => a - b);

  const scanDays = dayCount + 370;
  const offsetChanges =
    zone === "UTC" ? [] : findOffsetChanges(zone, zonedMidnight(firstDate, zone), scanDays);
  const changeOn = new Map(offsetChanges.map((c) => [dateInZone(c.at, zone), c] as const));
  // A picked day can be outside the days scanned (a `day` from another month than the one drawn).
  // It gets a look of its own, or its runs are an hour off when the clocks change on it.
  if (
    pickedDay &&
    zone !== "UTC" &&
    (pickedDay < firstDate || pickedDay >= shiftDate(firstDate, scanDays - 1))
  ) {
    const own = findOffsetChanges(zone, zonedMidnight(pickedDay, zone) - DAY, 3).find(
      (change) => dateInZone(change.at, zone) === pickedDay
    );
    if (own && !changeOn.has(pickedDay)) {
      offsetChanges.push(own);
      offsetChanges.sort((a, b) => a.at - b.at);
      changeOn.set(pickedDay, own);
    }
  }
  // A cron that runs in every hour of the day has nothing for a clock change to move: the hour
  // after a skipped one runs the same minutes, and a repeated hour runs them on both passes. Only a
  // change that touches midnight needs working out for it, as for any other cron.
  const everyHour = range.hours.length === 24;
  const aroundChange = new Map<OffsetChange, number[]>();
  /** The runs around a change, or undefined when the cron's fields give them. */
  const runsAround = (change: OffsetChange) => {
    if (!timezone || (everyHour && !changeTouchesMidnight(change))) return undefined;
    let runs = aroundChange.get(change);
    if (!runs) {
      runs = runsAroundChange(cron, timezone, change);
      aroundChange.set(change, runs);
    }
    return runs;
  };

  const firesOn = (date: string) => {
    const known = fires.get(date);
    if (known !== undefined) return known;
    // A day outside the range drawn (a picked day in another month).
    const single = calculateScheduleDays({
      cron,
      timezone,
      from: new Date(zonedMidnight(date, zone) + 12 * HOUR),
      dayCount: 1,
    });
    const result = single?.days[0]?.fires ?? false;
    fires.set(date, result);
    return result;
  };

  /** The wall clock at `instant`, as a UTC instant, on a day that may hold a clock change. */
  const wallAt = (instant: number, change: OffsetChange | undefined, dayOffset: number) =>
    instant + (change ? (instant < change.at ? change.before : change.after) : dayOffset) * MINUTE;

  const cronTimes = new Map<string, number[]>();
  /** The cron times on `date`, as instants. */
  const cronTimesOn = (date: string): number[] => {
    let known = cronTimes.get(date);
    if (!known) {
      known = computeCronTimesOn(date);
      cronTimes.set(date, known);
    }
    return known;
  };
  const computeCronTimesOn = (date: string): number[] => {
    if (!firesOn(date) || times.length === 0) return [];
    const wall = wallMidnight(date);
    const change = changeOn.get(date);
    if (!change) {
      const midnight = zonedMidnight(date, zone);
      return times.map((minutes) => midnight + minutes * MINUTE);
    }
    // Away from the change the fields hold, with the offset of that side of it; around it the
    // runs are worked out, because times there can be skipped, moved or run twice.
    const stepped = runsAround(change);
    const span = stepped ? changeSpan(change) : 0;
    const before = times
      .map((minutes) => wall + minutes * MINUTE - change.before * MINUTE)
      .filter((instant) => instant < change.at - span);
    const after = times
      .map((minutes) => wall + minutes * MINUTE - change.after * MINUTE)
      .filter((instant) => instant >= change.at + span);
    const around = (stepped ?? []).filter((instant) => dateInZone(instant, zone) === date);
    return [...before, ...around, ...after];
  };

  /** The first cron time on a later day, from the days drawn where they reach. */
  const firstRunAfterDay = (date: string, lastRun: number) => {
    for (let next = shiftDate(date, 1); fires.has(next); next = shiftDate(next, 1)) {
      const runs = cronTimesOn(next);
      if (runs.length > 0) return runs[0];
    }
    return firstRunAfter(cron, timezone, lastRun) ?? lastRun + DAY;
  };

  const timingsOn = (date: string, exactNext = false): ScheduleRunTiming[] => {
    const runs = cronTimesOn(date);
    if (runs.length === 0) return [];
    const last = runs[runs.length - 1];
    const after = exactNext
      ? (firstRunAfter(cron, timezone, last) ?? last + DAY)
      : firstRunAfterDay(date, last);
    return runs.map((run, index) => {
      const next = runs[index + 1] ?? after;
      // Two cron times can't share an instant; guard the timer against a zero interval.
      return runTiming(new Date(run), new Date(next > run ? next : run + MINUTE));
    });
  };

  // Days with the same runs share a pattern. An ordinary day's runs depend only on the gap from
  // its last run to the next day's first, so that gap is the key.
  const patterns: ScheduleDayRun[][] = [];
  const patternByGap = new Map<number, number>();
  const patternOf = (date: string): number | null => {
    const runs = cronTimesOn(date);
    if (runs.length === 0) return null;
    const change = changeOn.get(date);
    const last = runs[runs.length - 1];
    const gap = change ? undefined : firstRunAfterDay(date, last) - last;
    if (gap !== undefined) {
      const known = patternByGap.get(gap);
      if (known !== undefined) return known;
    }
    const wall = wallMidnight(date);
    const dayOffset = change ? 0 : (wall - zonedMidnight(date, zone)) / MINUTE;
    // Each instant is put on the wall clock on its own: a window that crosses the clock change
    // starts and ends on the other side of it from its cron time.
    const wallSeconds = (instant: Date) =>
      (wallAt(instant.getTime(), change, dayOffset) - wall) / 1000;
    const pattern = timingsOn(date).map((timing): ScheduleDayRun => [
      Math.round(wallSeconds(timing.nominalAt)),
      // Floored, so a day's times read the same as the day's table (which drops the fraction).
      Math.floor(wallSeconds(timing.effectiveAt)),
      Math.round(wallSeconds(timing.rangeEndAt)),
    ]);
    patterns.push(pattern);
    if (gap !== undefined) patternByGap.set(gap, patterns.length - 1);
    return patterns.length - 1;
  };

  const days = range.days.map((day) => ({ date: day.date, pattern: patternOf(day.date) }));
  const lastDate = days[days.length - 1].date;

  /** When the run at cron time `run` starts: later than `run` with a window. */
  const startOf = (run: number) =>
    runTiming(
      new Date(run),
      new Date(firstRunAfter(cron, timezone, run) ?? run + DAY)
    ).effectiveAt.getTime();
  /** A run is still to come until it starts, which with a window is after its cron time. */
  const stillToCome = (run: number | undefined): run is number =>
    run !== undefined && startOf(run) > nowMs;

  let selectedDay: string | undefined;
  if (active) {
    if (pickedDay) {
      selectedDay = pickedDay;
    } else if (month) {
      selectedDay = days.find((day) => day.date >= `${month}-01` && day.pattern !== null)?.date;
    } else {
      // The last cron time may not have started yet: its day is still the day to show.
      const waiting = lastScheduledRun(cron, timezone, nowMs);
      const next = stillToCome(waiting) ? waiting : firstRunAfter(cron, timezone, nowMs);
      selectedDay = next === undefined ? undefined : dateInZone(next, zone);
    }
  }

  let selected: ScheduleCalendar["selected"];
  if (selectedDay) {
    const start = zonedMidnight(selectedDay, zone);
    const end = zonedMidnight(shiftDate(selectedDay, 1), zone);
    const upcoming = timingsOn(selectedDay, true).filter(
      (timing) => timing.effectiveAt.getTime() > nowMs
    );
    const previous = lastRunBefore(cron, timezone, start);
    const next = firstRunAfter(cron, timezone, end - 1);
    selected = {
      day: selectedDay,
      runs: upcoming
        .slice(0, MAX_DAY_RUNS)
        .map((timing) => [timing.nominalAt.getTime(), timing.effectiveAt.getTime()]),
      truncated: upcoming.length > MAX_DAY_RUNS,
      previousDay: stillToCome(previous) ? dateInZone(previous, zone) : undefined,
      nextDay: next === undefined ? undefined : dateInZone(next, zone),
    };
  }

  const clockChanges = offsetChanges.map((change): ScheduleClockChange => {
    const date = dateInZone(change.at, zone);
    const shown = (date >= firstDate && date <= lastDate) || date === selectedDay;
    return shown
      ? describeClockChange(cron, change, runsAround(change))
      : {
          at: new Date(change.at),
          deltaMinutes: change.after - change.before,
          skipped: [],
          moved: [],
          repeated: [],
          once: [],
        };
  });

  const before = lastRunBefore(cron, timezone, zonedMidnight(firstDate, zone));
  const after = firstRunAfter(cron, timezone, zonedMidnight(shiftDate(lastDate, 1), zone) - 1);

  return {
    view,
    dense,
    month,
    days,
    patterns,
    clockChanges,
    runsBefore: stillToCome(before) ? dateInZone(before, zone) : undefined,
    runsAfter: after === undefined ? undefined : dateInZone(after, zone),
    selected,
  };
}
