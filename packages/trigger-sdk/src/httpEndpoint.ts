import {
  DisplayProperty,
  EventFilter,
  Prettify,
  RequestFilter,
  TriggerMetadata,
} from "@trigger.dev/core";
import { EventSpecification, EventSpecificationExample, Trigger } from "./types";
import { TriggerClient } from "./triggerClient";
import { Job } from "./job";
import { z } from "zod";
import { ParsedPayloadSchemaError } from "./errors";
import { formatSchemaErrors } from "./utils/formatSchemaErrors";

type HttpEndpointOptions<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  event: TEventSpecification;
};

export type RequestOptions = {
  filter?: EventFilter;
};

class HttpEndpoint<TEventSpecification extends EventSpecification<any>> {
  constructor(private readonly options: HttpEndpointOptions<TEventSpecification>) {}

  onRequest(options: RequestOptions): HttpTrigger<TEventSpecification> {
    return new HttpTrigger({
      endpointId: this.options.id,
      event: this.options.event,
      filter: options.filter,
    });
  }
}

type TriggerOptions<TEventSpecification extends EventSpecification<any>> = {
  endpointId: string;
  event: TEventSpecification;
  filter?: EventFilter;
};

class HttpTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  constructor(private readonly options: TriggerOptions<TEventSpecification>) {}

  toJSON(): TriggerMetadata {
    return {
      type: "httpendpoint",
      endpointId: this.options.endpointId,
      filter: this.options.filter,
    };
  }

  get event() {
    return this.options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {
    // triggerClient.attachModularTrigger({ key: this.#key, trigger: this });
  }

  get preprocessRuns() {
    return false;
  }
}

type RequestContext = {
  secret: string | undefined;
};

const HttpEndpointPayloadSchema = z.object({
  headers: z.record(z.string()),
  body: z.any(),
});

type HttpEndpointPayload = z.infer<typeof HttpEndpointPayloadSchema>;

export type EndpointOptions = {
  id: string;
  /** The source of the webhook, e.g. whatsapp.com  */
  source: string;
  title?: string;
  icon?: string;
  examples?: EventSpecificationExample[];
  properties?: DisplayProperty[];
  respondWith?: {
    filter?: RequestFilter;
    handler: (request: Request, context: RequestContext) => Promise<Response>;
  };
  verify: (request: Request, context: RequestContext) => Promise<boolean>;
};

export function httpEndpoint(
  options: EndpointOptions
): HttpEndpoint<EventSpecification<HttpEndpointPayload>> {
  return new HttpEndpoint({
    id: options.id,
    event: {
      name: options.id,
      title: options.title ?? "HTTP Trigger",
      source: options.source,
      icon: options.icon ?? "world-www",
      properties: options.properties,
      examples: options.examples,
      parsePayload: (rawPayload: any) => {
        const result = HttpEndpointPayloadSchema.safeParse(rawPayload);

        if (!result.success) {
          throw new ParsedPayloadSchemaError(formatSchemaErrors(result.error.issues));
        }

        return result.data;
      },
    },
  });
}
