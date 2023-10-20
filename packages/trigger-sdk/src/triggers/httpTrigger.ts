import { RequestFilterSchema } from "@trigger.dev/core";
import { z } from "zod";
import { TriggerClient } from "../triggerClient";

const HttpTriggerOptionsSchema = z.object({
  id: z.string(),
  verify: z
    .object({
      filter: RequestFilterSchema.optional(),
    })
    .optional(),
});

type HttpTriggerOptions = z.infer<typeof HttpTriggerOptionsSchema> & {
  verify?: {
    onRequest: (request: Request) => Promise<Response>;
  };
};

export class HttpTrigger {
  constructor(
    private readonly client: TriggerClient,
    options: HttpTriggerOptions
  ) {}
}

const trigger = new HttpTrigger(
  new TriggerClient({
    id: "",
  }),
  {
    id: "whatsapp",
  }
);
