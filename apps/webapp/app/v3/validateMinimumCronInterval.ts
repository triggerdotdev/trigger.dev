import { parseExpression } from "cron-parser";

/**
 * The free-plan minimum window, in seconds. Held as a code constant (not a schema default or a
 * DB default) so it can become e.g. 15 minutes before merge without rewriting the schema or any
 * historical rows. Persisted onto `TaskSchedule.minimumWindowDurationSeconds` at creation time.
 */
export const FREE_SCHEDULE_MINIMUM_WINDOW_SECONDS = 3600;

export type MinimumCronIntervalResult =
  | { valid: true }
  | { valid: false; message: string; smallestGapMs: number };

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MINUTES = 24 * 60;

/**
 * Deterministically checks a five-field cron's nominal wall-clock cadence against a minimum of up
 * to one hour. Expanding the hour and minute fields is sufficient for this policy: calendar fields
 * can only increase the distance between active days, while timezone/DST anomalies are deliberately
 * ignored. This rejects configured sub-hourly cadences without walking future occurrences.
 *
 * Accepts a gap exactly equal to `minimumMs` (e.g. `0 9,10 * * *` on a 60m minimum).
 */
export function validateMinimumCronInterval({
  cron,
  timezone,
  minimumMs,
}: {
  cron: string;
  timezone?: string | null;
  minimumMs: number;
}): MinimumCronIntervalResult {
  if (!Number.isSafeInteger(minimumMs) || minimumMs < 0 || minimumMs > HOUR_MS) {
    throw new RangeError("minimumMs must be a non-negative integer no greater than one hour");
  }

  const { fields } = parseExpression(cron, {
    utc: timezone === null || timezone === undefined,
    tz: timezone ?? undefined,
  });

  const minutesOfDay = fields.hour.flatMap((hour) =>
    fields.minute.map((minute) => hour * 60 + minute)
  );

  let smallestGapMinutes = DAY_MINUTES;
  for (let index = 1; index < minutesOfDay.length; index++) {
    smallestGapMinutes = Math.min(
      smallestGapMinutes,
      minutesOfDay[index] - minutesOfDay[index - 1]
    );
  }

  const overnightGapMinutes = DAY_MINUTES - minutesOfDay[minutesOfDay.length - 1] + minutesOfDay[0];
  smallestGapMinutes = Math.min(smallestGapMinutes, overnightGapMinutes);

  const smallestGapMs = smallestGapMinutes * MINUTE_MS;
  if (smallestGapMs >= minimumMs) {
    return { valid: true };
  }

  return {
    valid: false,
    smallestGapMs,
    message: `Cron fires every ${smallestGapMinutes} minutes, which is more frequent than the ${Math.round(
      minimumMs / MINUTE_MS
    )}-minute minimum`,
  };
}
