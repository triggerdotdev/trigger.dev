import {
  DisplayProperty,
  EventFilter,
  HttpEndpointMetadata,
  RequestWithRawBodySchema,
  RequestFilter,
  TriggerMetadata,
} from "@trigger.dev/core";
import { z } from "zod";
import { ParsedPayloadSchemaError } from "./errors";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";
import { EventSpecification, EventSpecificationExample, Trigger } from "./types";
import { formatSchemaErrors } from "./utils/formatSchemaErrors";
import { NormalizedResponse } from "@trigger.dev/core";

type HttpEndpointOptions<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  enabled?: boolean;
  event: TEventSpecification;
  respondWith?: RespondWith;
  verify: VerifyCallback;
};

export type RequestOptions = {
  filter?: EventFilter;
};

export class HttpEndpoint<TEventSpecification extends EventSpecification<any>> {
  constructor(private readonly options: HttpEndpointOptions<TEventSpecification>) {}

  get id() {
    return this.options.id;
  }

  onRequest(options?: RequestOptions): HttpTrigger<EventSpecification<Request>> {
    return new HttpTrigger({
      endpointId: this.options.id,
      event: this.options.event,
      filter: options?.filter,
    });
  }

  // @internal
  async handleRequest(request: Request, context: RequestContext): Promise<Response | undefined> {
    if (!this.options.respondWith) return;
    return this.options.respondWith.handler(request, context, () => {
      const clonedRequest = request.clone();
      return this.options.verify(clonedRequest, context);
    });
  }

  toJSON(): HttpEndpointMetadata {
    return {
      id: this.options.id,
      version: "1",
      enabled: this.options.enabled ?? true,
      event: this.options.event,
      immediateResponseFilter: this.options.respondWith?.filter,
      skipTriggeringRuns: this.options.respondWith?.skipTriggeringRuns,
      source: this.options.event.source,
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
        event: `httpendpoint.${this.options.endpointId}`,
        payload: this.options.filter ?? {},
        source: this.options.event.source,
      },
    };
  }

  get event() {
    return this.options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

  //todo this needs to return true, and we need to verify in preprocessing
  get preprocessRuns() {
    return false;
  }

  //todo EventRecord needs a payload type, e.g. JSON, REQUEST
}

type RequestContext = {
  secret: string;
};

type RespondWith = {
  filter?: RequestFilter;
  skipTriggeringRuns?: boolean;
  handler: (
    request: Request,
    context: RequestContext,
    verify: () => Promise<boolean>
  ) => Promise<Response>;
};

type VerifyCallback = (request: Request, context: RequestContext) => Promise<boolean>;

export type EndpointOptions = {
  id: string;
  enabled?: boolean;
  /** The source of the webhook, e.g. whatsapp.com  */
  source: string;
  title?: string;
  icon?: string;
  examples?: EventSpecificationExample[];
  properties?: DisplayProperty[];
  respondWith?: RespondWith;
  verify: VerifyCallback;
};

export function httpEndpoint(options: EndpointOptions): HttpEndpoint<EventSpecification<Request>> {
  return new HttpEndpoint({
    id: options.id,
    enabled: options.enabled,
    respondWith: options.respondWith,
    verify: options.verify,
    event: {
      name: options.id,
      title: options.title ?? "HTTP Trigger",
      source: options.source,
      icon: options.icon ?? "webhook",
      properties: options.properties,
      examples: options.examples
        ? options.examples
        : [
            {
              id: "basic-request",
              name: "Basic Request",
              icon: "http-post",
              payload: {
                url: "https://cloud.trigger.dev",
                method: "POST",
                headers: {
                  "Content-Type": "application/json",
                },
                rawBody: JSON.stringify({
                  foo: "bar",
                }),
              },
            },
          ],
      parsePayload: (rawPayload: any) => {
        const result = RequestWithRawBodySchema.safeParse(rawPayload);

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
