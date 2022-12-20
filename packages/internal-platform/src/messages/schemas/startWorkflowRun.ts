import { z } from "zod";

const Catalog = {
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

export default Catalog;
