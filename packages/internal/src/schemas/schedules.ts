import { z } from "zod";

export const ScheduledPayloadSchema = z.object({
  ts: z.coerce.date(),
  lastTimestamp: z.coerce.date().optional(),
});

export type ScheduledPayload = z.infer<typeof ScheduledPayloadSchema>;

export const IntervalOptionsSchema = z.object({
  seconds: z.number().int().positive().min(60).max(86400),
});

export type IntervalOptions = z.infer<typeof IntervalOptionsSchema>;

export const CronOptionsSchema = z.object({
  cron: z.string(),
});

export type CronOptions = z.infer<typeof CronOptionsSchema>;

export const CronMetadataSchema = z.object({
  type: z.literal("cron"),
  options: CronOptionsSchema,
});

export type CronMetadata = z.infer<typeof CronMetadataSchema>;

export const IntervalMetadataSchema = z.object({
  type: z.literal("interval"),
  options: IntervalOptionsSchema,
});

export type IntervalMetadata = z.infer<typeof IntervalMetadataSchema>;

export const ScheduleMetadataSchema = z.discriminatedUnion("type", [
  IntervalMetadataSchema,
  CronMetadataSchema,
]);

export type ScheduleMetadata = z.infer<typeof ScheduleMetadataSchema>;

export const RegisterSchedulePayloadSchema = z.object({
  id: z.string(),
  jobs: z.array(
    z.object({
      id: z.string(),
      version: z.string(),
    })
  ),
});

export type RegisterSchedulePayload = z.infer<
  typeof RegisterSchedulePayloadSchema
>;
