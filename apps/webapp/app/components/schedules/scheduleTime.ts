import type { ScheduleCalendar } from "~/v3/scheduleUpcoming.server";

/* Time formatting and timezone arithmetic for the schedule page's Upcoming tab. */

const formatters = new Map<string, Intl.DateTimeFormat>();

export function formatInZone(date: Date, timeZone: string, opts: Intl.DateTimeFormatOptions) {
  return new Intl.DateTimeFormat("en-US", { timeZone, ...opts }).format(date);
}

function partsInZone(date: Date, timeZone: string) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
      timeZoneName: "longOffset",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter.formatToParts(date);
}

export function minutesIntoDay(date: Date, timeZone: string) {
  const parts = partsInZone(date, timeZone);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

/** The timezone's offset from UTC in minutes at `date`. */
function offsetMinutes(date: Date, timeZone: string) {
  const name = partsInZone(date, timeZone).find((p) => p.type === "timeZoneName")?.value ?? "";
  const match = name.match(/([+-])(\d{2}):(\d{2})/);
  if (!match) return 0;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

export function formatMinutes(minutes: number) {
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return minutes > 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`;
}

/** 252000 → "4m 12s", 3600000 → "1h". */
export function formatOffset(ms: number) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return (
    [hours ? `${hours}h` : "", minutes ? `${minutes}m` : "", seconds ? `${seconds}s` : ""]
      .filter(Boolean)
      .join(" ") || "0s"
  );
}

/** "2026-11-19": the calendar date of `date` in `timeZone`. */
export function dateInZone(date: Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", { timeZone }).format(date);
}

/** "4:00 PM", or "4:04:12 PM" with `seconds` when the time has them. */
export function formatTime(date: Date, timeZone: string, seconds = false) {
  return formatInZone(date, timeZone, {
    hour: "numeric",
    minute: "2-digit",
    second: seconds && date.getTime() % 60_000 !== 0 ? "2-digit" : undefined,
  });
}

/** "2:00 AM becomes 3:00 AM": the wall clock either side of a daylight saving change. */
export function clockChangeLabel(at: Date, deltaMinutes: number, timeZone: string) {
  const after = wallMs(at, timeZone);
  const label = (wall: number) => formatClock(new Date(wall).toISOString().slice(11, 16));
  return `${label(after - deltaMinutes * 60_000)} becomes ${label(after)}`;
}

/** A wall-clock "02:30" as "2:30 AM". */
export function formatClock(label: string) {
  return formatInZone(new Date(`2000-01-01T${label}:00Z`), "UTC", {
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Milliseconds since the epoch of the wall clock in `timeZone` at `date`. */
function wallMs(date: Date, timeZone: string) {
  return date.getTime() + offsetMinutes(date, timeZone) * 60_000;
}

/** What a daylight saving change does to a schedule's runs, in a few words. */
export function clockChangeEffect(
  change: {
    deltaMinutes: number;
    skipped: string[];
    moved: Array<{ cronTime: string; at: Date }>;
    repeated: string[];
    once: string[];
  },
  timeZone: string
) {
  const list = (labels: string[]) =>
    labels.length > 3
      ? `${formatClock(labels[0])} to ${formatClock(labels[labels.length - 1])}`
      : labels.map(formatClock).join(", ");
  const parts: string[] = [];
  for (const moved of change.moved) {
    parts.push(
      `${formatClock(moved.cronTime)} doesn't exist, runs at ${formatTime(new Date(moved.at), timeZone)}`
    );
  }
  if (change.skipped.length) {
    parts.push(
      `${list(change.skipped)} ${change.skipped.length === 1 ? "doesn't exist and is" : "don't exist and are"} skipped`
    );
  }
  if (change.repeated.length) parts.push(`${list(change.repeated)} happen twice and run twice`);
  if (change.once.length) {
    parts.push(
      `${list(change.once)} ${change.once.length === 1 ? "happens" : "happen"} twice, runs once`
    );
  }
  return parts.join("; ");
}

/** The search params that choose what the Upcoming calendar shows. */
const CALENDAR_PARAMS = ["month", "day", "view"] as const;

/** Those params as one string ("day=2027-03-28&month=2027-03"): the calendar a URL asks for. */
export function scheduleCalendarKey(searchParams: URLSearchParams) {
  const key = new URLSearchParams();
  for (const name of CALENDAR_PARAMS) {
    const value = searchParams.get(name);
    if (value) key.set(name, value);
  }
  key.sort();
  return key.toString();
}

/** The search params with the calendar's own left out: everything else a URL asks for. */
function withoutScheduleCalendarParams(searchParams: URLSearchParams) {
  const rest = new URLSearchParams(searchParams);
  for (const name of CALENDAR_PARAMS) rest.delete(name);
  rest.sort();
  return rest.toString();
}

/** `search` with its calendar params replaced by those of `key`. */
export function withScheduleCalendarKey(search: string, key: string) {
  const params = new URLSearchParams(withoutScheduleCalendarParams(new URLSearchParams(search)));
  for (const [name, value] of new URLSearchParams(key)) params.set(name, value);
  return params.toString();
}

/** The instant `date` starts in `timeZone` (the calendar's loader works it out the same way). */
function zonedMidnight(date: string, timeZone: string) {
  const wall = new Date(`${date}T00:00:00Z`).getTime();
  const guess = wall - offsetMinutes(new Date(wall), timeZone) * 60_000;
  return wall - offsetMinutes(new Date(guess), timeZone) * 60_000;
}

/** The most runs listed for one day (the calendar's loader lists as many). */
const MAX_DAY_RUNS = 400;

/**
 * `calendar` with `day` picked, worked out from the days it already has, so picking a day needs
 * no request. Undefined where those days can't say and the loader has to: a day outside them, a
 * past day, or a day with a clock change (its runs come from stepping the cron).
 */
export function pickCalendarDay(
  calendar: ScheduleCalendar,
  day: string,
  timeZone: string,
  now: number
): ScheduleCalendar | undefined {
  const { days, patterns } = calendar;
  const index = days.findIndex((entry) => entry.date === day);
  const today = dateInZone(new Date(now), timeZone);
  if (index === -1 || day < today) return undefined;
  if (calendar.clockChanges.some((c) => dateInZone(new Date(c.at), timeZone) === day)) {
    return undefined;
  }

  const hasRuns = (entry: ScheduleCalendar["days"][number]) => entry.pattern !== null;
  const next = days.slice(index + 1).find(hasRuns);
  const previous = days.slice(0, index).reverse().find(hasRuns);
  const lastRun = (patterns[previous?.pattern ?? -1] ?? []).slice(-1)[0];
  const previousDay = !previous
    ? calendar.runsBefore
    : previous.date > today ||
        // Today counts while it has a run left.
        (previous.date === today &&
          lastRun !== undefined &&
          lastRun[1] > minutesIntoDay(new Date(now), timeZone) * 60)
      ? previous.date
      : undefined;

  const midnight = zonedMidnight(day, timeZone);
  const pattern = days[index].pattern;
  const upcoming = (pattern === null ? [] : (patterns[pattern] ?? []))
    .map(([cron, start]): [number, number] => [midnight + cron * 1000, midnight + start * 1000])
    // A run is still to come until it starts, which with a window is after its cron time.
    .filter(([, startAt]) => startAt > now);

  return {
    ...calendar,
    selected: {
      day,
      runs: upcoming.slice(0, MAX_DAY_RUNS),
      truncated: upcoming.length > MAX_DAY_RUNS,
      previousDay,
      nextDay: next ? next.date : calendar.runsAfter,
    },
  };
}
