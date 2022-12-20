import { WaitSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";

const Catalog = {
  INITIATE_WAIT: {
    data: z.object({
      id: z.string(),
      wait: WaitSchema,
    }),
    properties: z.object({
      "x-workflow-id": z.string(),
      "x-api-key": z.string(),
    }),
  },
};

export default Catalog;
