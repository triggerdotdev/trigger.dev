import cronParser from "cron-parser";
const { parseExpression } = cronParser;

export function calculateNextScheduledTimestamp(
  schedule: string,
  timezone: string | null,
  lastScheduledTimestamp: Date = new Date()
) {
  let nextStep = calculateNextStep(schedule, timezone, lastScheduledTimestamp);

  while (nextStep.getTime() < Date.now()) {
    nextStep = calculateNextStep(schedule, timezone, nextStep);
  }

  return nextStep;
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
