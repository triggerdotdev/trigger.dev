import { z } from "zod";
import { ErrorSchema } from "@trigger.dev/common-schemas";

const Catalog = {
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
};

export default Catalog;
