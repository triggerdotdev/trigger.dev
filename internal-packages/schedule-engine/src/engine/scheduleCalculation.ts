import { parseExpression } from "cron-parser";

export function calculateNextScheduledTimestampFromNow(schedule: string, timezone: string | null) {
  return calculateNextScheduledTimestamp(schedule, timezone, new Date());
}

export function calculateNextScheduledTimestamp(
  schedule: string,
  timezone: string | null,
  currentDate: Date = new Date()
) {
  return calculateNextStep(schedule, timezone, currentDate);
}

function calculateNextStep(schedule: string, timezone: string | null, currentDate: Date) {
  return parseExpression(schedule, {
    currentDate,
    utc: timezone === null,
    tz: timezone ?? undefined,
  })
    .next()
    .toDate();
}

export function nextScheduledTimestamps(
  cron: string,
  timezone: string | null,
  lastScheduledTimestamp: Date,
  count: number = 1
) {
  const result: Array<Date> = [];
  let nextScheduledTimestamp = lastScheduledTimestamp;

  for (let i = 0; i < count; i++) {
    nextScheduledTimestamp = calculateNextScheduledTimestamp(
      cron,
      timezone,
      nextScheduledTimestamp
    );

    result.push(nextScheduledTimestamp);
  }

  return result;
}
