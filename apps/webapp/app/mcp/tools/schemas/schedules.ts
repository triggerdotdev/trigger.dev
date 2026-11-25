import { z } from "zod";
import { CommonProjectsInput } from "./common";

export const SCHEDULE_ID = /^sched_[0-9A-Za-z]{1,64}$/;

const scheduleId = z
  .string()
  .max(70)
  .regex(SCHEDULE_ID, "Must be lowercase sched_ followed by letters and digits")
  .describe("The schedule ID, starts with sched_. Use list_schedules to find it.");

const cron = z
  .string()
  .min(1)
  .max(100)
  .describe(
    'A cron expression with 5 fields (minute hour day-of-month month day-of-week), e.g. "0 9 * * 1-5". Seconds are not allowed.'
  );

const timezone = z
  .string()
  .min(1)
  .max(64)
  .describe('An IANA timezone the cron is evaluated in, e.g. "Europe/London". Defaults to UTC.');

const window = z
  .string()
  .min(1)
  .max(16)
  .describe(
    'Spread each run over a window after its fire time, as a duration ("30m", "2h", up to 24h) or a share of the gap until the next fire time ("50%").'
  );

export const ListSchedulesInput = CommonProjectsInput.extend({
  tasks: z
    .array(z.string().min(1).max(128))
    .min(1)
    .max(20)
    .describe("Only schedules for these task IDs")
    .optional(),
  search: z
    .string()
    .min(1)
    .max(128)
    .describe("Only schedules whose ID, external ID, deduplication key or cron contains this text")
    .optional(),
  type: z
    .enum(["declarative", "imperative"])
    .describe(
      "declarative: defined in code and synced on deploy. imperative: created in the dashboard or with the API."
    )
    .optional(),
  page: z.number().int().min(1).max(1000).describe("The page to return (default 1)").optional(),
  limit: z.number().int().min(1).max(50).describe("How many per page (default 20)").optional(),
});

export const ScheduleIdInput = CommonProjectsInput.extend({ scheduleId });

export const CreateScheduleInput = CommonProjectsInput.extend({
  taskId: z
    .string()
    .min(1)
    .max(128)
    .describe("The ID of a scheduled task (defined with schedules.task) in this environment"),
  cron,
  timezone: timezone.optional(),
  externalId: z
    .string()
    .min(1)
    .max(256)
    .describe("Your own ID for this schedule, passed to every run it triggers, e.g. a user ID")
    .optional(),
  deduplicationKey: z
    .string()
    .min(1)
    .max(256)
    .describe(
      "A key unique in the project. A schedule with this key must not exist yet. It cannot be changed later."
    )
    .optional(),
  window: window.optional(),
});

export const UpdateScheduleInput = CommonProjectsInput.extend({
  scheduleId,
  cron: cron.optional(),
  timezone: timezone.optional(),
  externalId: z
    .string()
    .min(1)
    .max(256)
    .nullable()
    .describe("A new external ID, or null to remove it. Omit to keep the current one.")
    .optional(),
  window: window
    .nullable()
    .describe(
      "A new window, or null to remove it (a default window captured when the schedule was created then applies). Omit to keep the current one."
    )
    .optional(),
});

export type CreateScheduleInput = z.output<typeof CreateScheduleInput>;
export type UpdateScheduleInput = z.output<typeof UpdateScheduleInput>;
