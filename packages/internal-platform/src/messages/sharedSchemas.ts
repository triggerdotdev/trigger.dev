import { z } from "zod";

export const WorkflowEventPropertiesSchema = z.object({
  "x-workflow-id": z.string(),
  "x-org-id": z.string(),
  "x-api-key": z.string(),
  "x-env": z.string(),
});

export const WorkflowRunEventPropertiesSchema =
  WorkflowEventPropertiesSchema.extend({
    "x-workflow-run-id": z.string(),
  });

export const WorkflowSendEventPropertiesSchema = z.object({
  "x-workflow-id": z.string(),
  "x-api-key": z.string(),
});

export const WorkflowSendRunEventPropertiesSchema =
  WorkflowSendEventPropertiesSchema.extend({
    "x-workflow-run-id": z.string(),
    "x-timestamp": z.string(),
  });
