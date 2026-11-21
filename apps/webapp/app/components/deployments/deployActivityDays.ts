/* The calendar arithmetic behind the deployment activity grid: plain functions, no React, so the
 * grid, the band beside it and the list's day filter agree on what a day and a week are. */

export type ActivityDay = {
  /** YYYY-MM-DD. */
  day: string;
  /** Every deployment started that day. */
  total: number;
  /** The ones that went live. */
  deployed: number;
  /** Failed or timed out. */
  failed: number;
};

export const GRID_WEEKS = 53;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Calendar days are plain YYYY-MM-DD strings; the arithmetic runs on UTC midnights. */
export function parseDay(day: string): Date {
  return new Date(`${day}T00:00:00Z`);
}

export function addDays(day: string, count: number): string {
  return new Date(parseDay(day).getTime() + count * DAY_MS).toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((parseDay(to).getTime() - parseDay(from).getTime()) / DAY_MS);
}

/** Monday first: deploys are weekday work, so the weekend sits together at the end of a week. */
function weekdayIndex(day: string): number {
  return (parseDay(day).getUTCDay() + 6) % 7;
}

/** The grid's weeks, oldest first, each Monday to Sunday. Days after `today` are null. */
export function gridWeeks(today: string, weeks = GRID_WEEKS): (string | null)[][] {
  const lastMonday = addDays(today, -weekdayIndex(today));
  const firstMonday = addDays(lastMonday, -(weeks - 1) * 7);
  return Array.from({ length: weeks }, (_, week) =>
    Array.from({ length: 7 }, (_, weekday) => {
      const day = addDays(firstMonday, week * 7 + weekday);
      return day > today ? null : day;
    })
  );
}

/**
 * A real calendar day written YYYY-MM-DD ("2026-02-31" isn't one), no earlier than 1970: the
 * database has no year 0, and nothing was deployed before then.
 */
export function isCalendarDay(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value < "1970-01-01") return false;
  const date = parseDay(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

type ActivitySummary = {
  total: number;
  deployed: number;
  failed: number;
  /** Weeks in the grid with at least one deploy that went live. */
  activeWeeks: number;
  weeks: number;
  /** The longest run of days with nothing going live, between the first deploy and today. */
  longestGap?: { from: string; to: string; days: number };
};

/** What the grid adds up to, for the figures beside it. */
export function summarizeActivity(today: string, days: ActivityDay[], weeks = GRID_WEEKS) {
  const columns = gridWeeks(today, weeks);
  const first = columns[0]?.[0] ?? today;
  const inRange = days.filter((entry) => entry.day >= first && entry.day <= today);
  const live = new Set(inRange.filter((entry) => entry.deployed > 0).map((entry) => entry.day));

  let longestGap: ActivitySummary["longestGap"];
  const shipped = [...live].sort();
  for (let index = 0; index < shipped.length; index += 1) {
    const from = addDays(shipped[index], 1);
    const until = shipped[index + 1] ?? addDays(today, 1);
    const length = daysBetween(from, until);
    if (length > 0 && (!longestGap || length > longestGap.days)) {
      longestGap = { from, to: addDays(until, -1), days: length };
    }
  }

  const summary: ActivitySummary = {
    total: inRange.reduce((sum, entry) => sum + entry.total, 0),
    deployed: inRange.reduce((sum, entry) => sum + entry.deployed, 0),
    failed: inRange.reduce((sum, entry) => sum + entry.failed, 0),
    activeWeeks: columns.filter((week) => week.some((day) => day && live.has(day))).length,
    weeks,
    longestGap,
  };
  return summary;
}

/** "Dec 20 to Jan 4", or one date when both ends are the same day. */
export function formatDayRange(from: string, to: string, locales: string[]) {
  const format = (day: string) =>
    parseDay(day).toLocaleDateString(locales, { timeZone: "UTC", month: "short", day: "numeric" });
  return from === to ? format(from) : `${format(from)} to ${format(to)}`;
}
