import { parseExpression } from "cron-parser";

export function calculateNextScheduledTimestamp(
  schedule: string,
  timezone: string | null,
  lastScheduledTimestamp: Date = new Date()
) {
  const now = Date.now();

  let nextStep = calculateNextStep(schedule, timezone, lastScheduledTimestamp);

  // If the next step is still in the past, we might need to skip ahead
  if (nextStep.getTime() <= now) {
    // Calculate a second step to determine the interval
    const secondStep = calculateNextStep(schedule, timezone, nextStep);
    const interval = secondStep.getTime() - nextStep.getTime();

    // If we have a consistent interval and it would take many iterations,
    // skip ahead mathematically instead of iterating
    if (interval > 0) {
      const stepsNeeded = Math.floor((now - nextStep.getTime()) / interval);

      // Only skip ahead if it would save us more than a few iterations
      if (stepsNeeded > 10) {
        // Skip ahead by calculating how many intervals to add
        const skipAheadTime = nextStep.getTime() + stepsNeeded * interval;
        nextStep = calculateNextStep(schedule, timezone, new Date(skipAheadTime));
      }
    }

    // Use the normal iteration for the remaining steps (should be <= 10 now)
    while (nextStep.getTime() <= now) {
      nextStep = calculateNextStep(schedule, timezone, nextStep);
    }
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
