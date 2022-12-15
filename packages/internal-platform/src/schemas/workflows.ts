import { z } from "zod";

export const CustomEventTriggerSchema = z.object({
  type: z.literal("CUSTOM_EVENT"),
  config: z.object({
    name: z.string(),
  }),
});

export const WebhookEventTriggerSchema = z.object({
  type: z.literal("WEBHOOK"),
  config: z.object({
    id: z.string(),
    params: z.record(z.string()),
  }),
});

export const HttpEventTriggerSchema = z.object({
  type: z.literal("HTTP_ENDPOINT"),
  config: z.object({
    method: z.enum([
      "GET",
      "POST",
      "PUT",
      "DELETE",
      "PATCH",
      "HEAD",
      "OPTIONS",
    ]),
    path: z.string().optional(),
  }),
});

export const ScheduledEventTriggerSchema = z.object({
  type: z.literal("SCHEDULE"),
  config: z.object({
    cron: z.string(),
  }),
});

export const TriggerMetadataSchema = z.discriminatedUnion("type", [
  CustomEventTriggerSchema,
  WebhookEventTriggerSchema,
  HttpEventTriggerSchema,
  ScheduledEventTriggerSchema,
]);

export const PackageMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const WorkflowMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: TriggerMetadataSchema,
  package: PackageMetadataSchema,
});

export type WorkflowMetadata = z.infer<typeof WorkflowMetadataSchema>;
