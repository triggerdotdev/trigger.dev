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
    webhook: z.any(),
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

export const UpdateRunningWorkflowRunSchema = z.object({
  status: z.literal("RUNNING"),
});

export const UpdateCompletedWorkflowRunSchema = z.object({
  status: z.literal("COMPLETED"),
  output: z.string(),
});

export const UpdateFailedWorkflowRunSchema = z.object({
  status: z.literal("FAILED"),
  error: z.object({
    name: z.string(),
    message: z.string(),
    stackTrace: z.string().optional(),
  }),
});

export const UpdateWorkflowRunSchema = z.discriminatedUnion("status", [
  UpdateRunningWorkflowRunSchema,
  UpdateCompletedWorkflowRunSchema,
  UpdateFailedWorkflowRunSchema,
]);

export type UpdateWorkflowRun = z.infer<typeof UpdateWorkflowRunSchema>;
