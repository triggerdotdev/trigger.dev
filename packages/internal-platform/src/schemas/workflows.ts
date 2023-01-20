import { TriggerMetadataSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

export const PackageMetadataSchema = z.object({
  name: z.string(),
  version: z.string(),
});

export const WorkflowMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  trigger: TriggerMetadataSchema,
  package: PackageMetadataSchema,
  triggerTTL: z.number().optional(),
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
