import { EventFilterSchema, stringPatternMatchers } from "@trigger.dev/core";
import { TriggerClient } from "../triggerClient";
import { z } from "zod";

const StringMatchSchema = z.union([
  /** Match against a string */
  z.array(z.string()),
  z.array(z.union(stringPatternMatchers)),
]);

const RequestFilterSchema = z.object({
  headers: z.record(StringMatchSchema),
  query: z.record(StringMatchSchema),
  body: EventFilterSchema.optional(),
});

const HttpTriggerOptionsSchema = z.object({
  id: z.string(),
  verify: z
    .object({
      filter: RequestFilterSchema.optional(),
    })
    .optional(),
});

type HttpTriggerOptions = z.infer<typeof HttpTriggerOptionsSchema> & {
  verify: {
    onRequest: (request: Request) => Promise<Response>;
  };
};

export class HttpTrigger {
  constructor(
    private readonly client: TriggerClient,
    options: HttpTriggerOptions
  ) {}
}
