import type {
  ScheduleSource,
  ScheduleSourceRate,
  ScheduleSourceCron,
  ScheduledEventPayload,
} from "@trigger.dev/common-schemas";

import { parseExpression } from "cron-parser";

export function calculateNextScheduledEvent(
  source: ScheduleSource,
  previousPayload?: ScheduledEventPayload
): Date {
  if ("rateOf" in source) {
    return calculateNextRateOfEvent(source, previousPayload);
  }

  if ("cron" in source) {
    return calculateNextCronEvent(source, previousPayload);
  }

  throw new Error("Invalid schedule source");
}

function calculateNextRateOfEvent(
  source: ScheduleSourceRate,
  previousPayload?: ScheduledEventPayload
): Date {
  const now = new Date();

  if (!previousPayload) {
    return new Date(now.getTime() + calculateDurationInMs(source));
  }

  return new Date(
    previousPayload.scheduledTime.getTime() + calculateDurationInMs(source)
  );
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
  previousPayload?: ScheduledEventPayload
): Date {
  const now = new Date();

  if (!previousPayload) {
    return parseExpression(source.cron, {
      currentDate: now,
    })
      .next()
      .toDate();
  }

  return parseExpression(source.cron, {
    currentDate: previousPayload.scheduledTime,
  })
    .next()
    .toDate();
}
