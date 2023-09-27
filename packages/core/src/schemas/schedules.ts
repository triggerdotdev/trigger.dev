import { z } from "zod";

export const SCHEDULED_EVENT = "dev.trigger.scheduled";

export const ScheduledPayloadSchema = z.object({
  ts: z.coerce.date(),
  lastTimestamp: z.coerce.date().optional(),
});

export type ScheduledPayload = z.infer<typeof ScheduledPayloadSchema>;

export const IntervalOptionsSchema = z.object({
  /** The number of seconds for the interval. Min = 60, Max = 2_592_000 (30 days) */
  seconds: z.number().int().positive().min(60).max(2_592_000),
});

/** Interval options */
export type IntervalOptions = z.infer<typeof IntervalOptionsSchema>;

export const CronOptionsSchema = z.object({
  /** A CRON expression that defines the schedule. A useful tool when writing CRON
    expressions is [crontab guru](https://crontab.guru). Note that the timezone
    used is UTC. */
  cron: z.string(),
});

/** The options for a `cronTrigger()` */
export type CronOptions = z.infer<typeof CronOptionsSchema>;

export const CronMetadataSchema = z.object({
  type: z.literal("cron"),
  options: CronOptionsSchema,
  /** An optional Account ID to associate with runs triggered by this interval */
  accountId: z.string().optional(),
  metadata: z.any(),
});

export type CronMetadata = z.infer<typeof CronMetadataSchema>;

export const IntervalMetadataSchema = z.object({
  /** An interval reoccurs at the specified number of seconds  */
  type: z.literal("interval"),
  /** An object containing options about the interval. */
  options: IntervalOptionsSchema,
  /** An optional Account ID to associate with runs triggered by this interval */
  accountId: z.string().optional(),
  /** Any additional metadata about the schedule. */
  metadata: z.any(),
});

export type IntervalMetadata = z.infer<typeof IntervalMetadataSchema>;

export const ScheduleMetadataSchema = z.discriminatedUnion("type", [
  IntervalMetadataSchema,
  CronMetadataSchema,
]);

export type ScheduleMetadata = z.infer<typeof ScheduleMetadataSchema>;

export const RegisterDynamicSchedulePayloadSchema = z.object({
  id: z.string(),
  jobs: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
    })
  ),
});

export type RegisterDynamicSchedulePayload = z.infer<typeof RegisterDynamicSchedulePayloadSchema>;
