import {
  DisplayProperty,
  EventFilter,
  HttpEndpointMetadata,
  RequestFilter,
  RequestWithRawBodySchema,
  TriggerMetadata,
} from "@trigger.dev/core";
import { ParsedPayloadSchemaError } from "./errors.js";
import { Job } from "./job.js";
import { TriggerClient } from "./triggerClient.js";
import { EventSpecification, EventSpecificationExample, Trigger, VerifyResult } from "./types.js";
import { formatSchemaErrors } from "./utils/formatSchemaErrors.js";
import { slugifyId } from "./utils.js";

type HttpEndpointOptions<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  enabled?: boolean;
  event: TEventSpecification;
  respondWith?: RespondWith;
  verify: VerifyCallback;
};

export type RequestOptions = {
  filter?: RequestFilter;
};

export class HttpEndpoint<TEventSpecification extends EventSpecification<any>> {
  constructor(private readonly options: HttpEndpointOptions<TEventSpecification>) {}

  get id() {
    return this.options.id;
  }

  onRequest(options?: RequestOptions): HttpTrigger<EventSpecification<Request>> {
    return new HttpTrigger({
      endpointId: this.id,
      event: this.options.event,
      filter: options?.filter,
      verify: this.options.verify,
    });
  }

  // @internal
  async handleRequest(request: Request): Promise<Response | undefined> {
    if (!this.options.respondWith) return;
    return this.options.respondWith.handler(request, () => {
      const clonedRequest = request.clone();
      return this.options.verify(clonedRequest);
    });
  }

  toJSON(): HttpEndpointMetadata {
    return {
      id: this.id,
      icon: this.options.event.icon,
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
  verify: VerifyCallback;
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
      link: `http-endpoints/${this.options.endpointId}`,
      help: {
        noRuns: {
          text: "To start triggering runs click here to setup your HTTP Endpoint with the external API service you want to receive webhooks from.",
          link: `http-endpoints/${this.options.endpointId}`,
        },
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

  async verifyPayload(payload: Request) {
    const clonedRequest = payload.clone();
    return this.options.verify(clonedRequest);
  }
}

type RespondWith = {
  /** Only Requests that match this filter will cause the `handler` function to run.
   * For example, you can use this to only respond to `GET` Requests. */
  filter?: RequestFilter;
  /** If you set this to `true`, the Request that comes in won't go on to Trigger any Runs.
   * This is useful if you want to Respond to the Request, but don't want to Trigger any Runs. */
  skipTriggeringRuns?: boolean;
  /** This is a function that's called when a Request comes in.
   * It's passed the Request object, and expects you to return a Response object. */
  handler: (request: Request, verify: () => Promise<VerifyResult>) => Promise<Response>;
};

export type VerifyCallback = (request: Request) => Promise<VerifyResult>;

export type EndpointOptions = {
  /** Used to uniquely identify the HTTP Endpoint inside your Project. */
  id: string;
  enabled?: boolean;
  /** Usually you would use the domain name of the service, e.g. `cal.com`. */
  source: string;
  /** An optional title, displayed in the dashboard. */
  title?: string;
  /** An optional icon name that's displayed in the dashboard.
   * Lots of company names are supported, e.g. `github`, `twilio`.
   * You can also reference the name of any [Tabler icon](https://tabler-icons.io/), e.g. `brand-google-maps`, `brand-twitch`. */
  icon?: string;
  /** Used to provide example payloads that are accepted by the job.
   * This will be available in the dashboard and can be used to trigger test runs. */
  examples?: EventSpecificationExample[];
  /** Properties that are displayed in the dashboard. */
  properties?: DisplayProperty[];
  /** This optional object allows you to immediately Respond to a Request. This is useful for some APIs where they do a `GET` Request when the webhook is first setup and expect a specific Response.

      Only use this if you really need to Respond to the Request that comes in. Most of the time you don't. */
  respondWith?: RespondWith;
  /** This is compulsory, and is used to verify that the received webhook is authentic.
   * It's a function that expects you to return a result object like:
    
  In 90% of cases, you'll want to use the `verifyRequestSignature` helper function we provide.

    @example
    ```ts
    //if it's valid
    return { success: true }
    //if it's invalid, reason is optional
    return { success: false, reason: "No header" }
    ```

   */
  verify: VerifyCallback;
};

export function httpEndpoint(options: EndpointOptions): HttpEndpoint<EventSpecification<Request>> {
  const id = slugifyId(options.id);

  return new HttpEndpoint({
    id,
    enabled: options.enabled,
    respondWith: options.respondWith,
    verify: options.verify,
    event: {
      name: id,
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
