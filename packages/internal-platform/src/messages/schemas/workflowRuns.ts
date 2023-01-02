import { ErrorSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

export const coordinator = {
  COMPLETE_WORKFLOW_RUN: {
    data: z.object({
      id: z.string(),
      output: z.string(),
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
  FAIL_WORKFLOW_RUN: {
    data: z.object({
      id: z.string(),
      error: ErrorSchema,
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
  START_WORKFLOW_RUN: {
    data: z.object({
      id: z.string(),
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
};
