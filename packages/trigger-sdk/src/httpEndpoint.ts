import {
  DisplayProperty,
  EventFilter,
  HttpEndpointMetadata,
  RequestFilter,
  TriggerMetadata,
} from "@trigger.dev/core";
import { z } from "zod";
import { ParsedPayloadSchemaError } from "./errors";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";
import { EventSpecification, EventSpecificationExample, Trigger } from "./types";
import { formatSchemaErrors } from "./utils/formatSchemaErrors";

type HttpEndpointOptions<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  event: TEventSpecification;
};

export type RequestOptions = {
  filter?: EventFilter;
};

export class HttpEndpoint<TEventSpecification extends EventSpecification<any>> {
  constructor(private readonly options: HttpEndpointOptions<TEventSpecification>) {}

  get id() {
    return this.options.id;
  }

  onRequest(options: RequestOptions): HttpTrigger<EventSpecification<Request>> {
    return new HttpTrigger({
      endpointId: this.options.id,
      event: this.options.event,
      filter: options.filter,
    });
  }

  toJSON(): HttpEndpointMetadata {
    return {
      id: this.options.id,
      version: "1",
      event: this.options.event,
    };
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
      type: "static",
      title: this.options.endpointId,
      properties: this.options.event.properties,
      rule: {
        event: this.options.endpointId,
        payload: this.options.filter ?? {},
        source: this.options.event.source,
      },
    };
  }

  get event() {
    return this.options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

  get preprocessRuns() {
    return false;
  }
}

type RequestContext = {
  secret: string | undefined;
};

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

const RawHttpEndpointPayloadSchema = z.object({
  url: z.string(),
  method: z.string(),
  headers: z.record(z.string()),
  rawBody: z.string(),
});

export function httpEndpoint(options: EndpointOptions): HttpEndpoint<EventSpecification<Request>> {
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
        const result = RawHttpEndpointPayloadSchema.safeParse(rawPayload);

        if (!result.success) {
          throw new ParsedPayloadSchemaError(formatSchemaErrors(result.error.issues));
        }

        return new Request(new URL(result.data.url), {
          method: result.data.method,
          headers: result.data.headers,
          body: result.data.rawBody,
        });
      },
    },
  });
}
