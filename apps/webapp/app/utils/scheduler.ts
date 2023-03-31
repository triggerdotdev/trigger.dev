import type {
  ScheduleSource,
  ScheduleSourceCron,
  ScheduleSourceRate,
} from "@trigger.dev/internal";

import { parseExpression } from "cron-parser";

export function calculateNextScheduledEvent(
  source: ScheduleSource,
  lastRunAt?: Date
): Date {
  if ("rateOf" in source) {
    return calculateNextRateOfEvent(source, lastRunAt);
  }

  if ("cron" in source) {
    return calculateNextCronEvent(source, lastRunAt);
  }

  throw new Error("Invalid schedule source");
}

function calculateNextRateOfEvent(
  source: ScheduleSourceRate,
  lastRunAt?: Date
): Date {
  const now = new Date();

  if (!lastRunAt) {
    return new Date(now.getTime() + calculateDurationInMs(source));
  }

  return new Date(lastRunAt.getTime() + calculateDurationInMs(source));
}

function calculateDurationInMs(source: ScheduleSourceRate): number {
  if ("minutes" in source.rateOf) {
    return source.rateOf.minutes * 60 * 1000;
  }

  if ("hours" in source.rateOf) {
    return source.rateOf.hours * 60 * 60 * 1000;
  }

  if ("days" in source.rateOf) {
    return source.rateOf.days * 24 * 60 * 60 * 1000;
  }

  throw new Error("Invalid rate of");
}

function calculateNextCronEvent(
  source: ScheduleSourceCron,
  lastRunAt?: Date
): Date {
  const now = new Date();

  if (!lastRunAt) {
    return parseExpression(source.cron, {
      currentDate: now,
    })
      .next()
      .toDate();
  }

  return parseExpression(source.cron, {
    currentDate: lastRunAt,
  })
    .next()
    .toDate();
}
