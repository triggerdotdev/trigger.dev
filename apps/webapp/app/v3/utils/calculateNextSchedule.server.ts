import cronParser from "cron-parser";

const { parseExpression } = cronParser;
export function calculateNextScheduledTimestamp(
  schedule: string,
  lastScheduledTimestamp: Date = new Date()
) {
  let nextStep = calculateNextStep(schedule, lastScheduledTimestamp);

  while (nextStep.getTime() < Date.now()) {
    nextStep = calculateNextStep(schedule, nextStep);
  }

  return nextStep;
}

function calculateNextStep(schedule: string, currentDate: Date) {
  return parseExpression(schedule, {
    currentDate,
    utc: true,
  })
    .next()
    .toDate();
}

export function nextScheduledTimestamps(
  cron: string,
  lastScheduledTimestamp: Date,
  count: number = 1
) {
  const result: Array<Date> = [];
  let nextScheduledTimestamp = lastScheduledTimestamp;

  for (let i = 0; i < count; i++) {
    nextScheduledTimestamp = calculateNextScheduledTimestamp(cron, nextScheduledTimestamp);

    result.push(nextScheduledTimestamp);
  }

  return result;
}
