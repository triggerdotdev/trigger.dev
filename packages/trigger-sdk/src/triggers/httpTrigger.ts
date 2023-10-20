import {
  DisplayPropertiesSchema,
  EventFilter,
  EventFilterSchema,
  RequestFilterSchema,
} from "@trigger.dev/core";
import { z } from "zod";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, EventSpecificationExampleSchema, Trigger } from "../types";
import { Job } from "../job";

const HttpTriggerOptionsSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  icon: z.string().optional(),
  properties: DisplayPropertiesSchema.optional(),
  verify: z
    .object({
      requestFilter: RequestFilterSchema.optional(),
    })
    .optional(),
  payload: z
    .object({
      requestFilter: RequestFilterSchema.optional(),
      schema: z.any().optional(),
      examples: z.array(EventSpecificationExampleSchema).optional(),
      filter: EventFilterSchema.optional(),
    })
    .optional(),
});

type HttpTriggerOptions = z.infer<typeof HttpTriggerOptionsSchema> & {
  verify?: {
    onRequest: (request: Request) => Promise<Response>;
  };
};

export class HttpTrigger<TEventSpecification extends EventSpecification<TEvent>, TEvent = any>
  implements Trigger<TEventSpecification>
{
  constructor(
    private readonly client: TriggerClient,
    private readonly options: HttpTriggerOptions
  ) {}

  get event() {
    return {
      name: this.options.id,
      title: this.options.title ?? "http",
      source: "http",
      icon: this.options.icon ?? "world-www",
      properties: this.options.properties,
      schema: this.options.payload?.schema,
      examples: this.options.payload?.examples,
      filter: this.options.payload?.filter,
      parsePayload: (payload: unknown) => payload as TEvent,
      runProperties: (payload: TEvent) => [],
    };
  }

  toJSON() {
    return {
      type: "modular" as const,
      id: this.options.id,
    };
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {
    throw new Error("Method not implemented.");
  }

  get preprocessRuns() {
    return true;
  }
}

const trigger = new HttpTrigger(
  new TriggerClient({
    id: "",
  }),
  {
    id: "whatsapp",
  }
);
