import {
  DisplayProperty,
  EventFilter,
  HttpMethod,
  Prettify,
  RequestFilter,
  TriggerMetadata,
} from "@trigger.dev/core";
import { ParsedPayloadSchemaError } from "../errors";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, EventSpecificationExample, SchemaParser, Trigger } from "../types";
import { formatSchemaErrors } from "../utils/formatSchemaErrors";
import { SendEvent } from "@trigger.dev/core";

type Options<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  event: TEventSpecification;
};

export class HttpTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  constructor(private readonly options: Options<TEventSpecification>) {}

  toJSON(): TriggerMetadata {
    return {
      type: "modular",
      key: this.#key,
    };
  }

  get #key() {
    return `http-trigger-${this.options.id}`;
  }

  get event() {
    return this.options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {
    //todo create the actual modular trigger, and pass that through
    //the modular trigger is what will be used outside of HttpTriggers as well
    // triggerClient.attachModularTrigger({ key: this.#key, trigger: this });
  }

  get preprocessRuns() {
    return false;
  }
}

type RequestContext = {
  secret: string | undefined;
};

/** Configuration options for an EventTrigger */
export type HttpTriggerOptions<TEvent> = {
  id: string;
  /** The hostname of the webhook, e.g. whatsapp.com  */
  hostname: string;
  title?: string;
  icon?: string;
  bodySchema?: SchemaParser<TEvent>;
  filter?: EventFilter;
  examples?: EventSpecificationExample[];
  properties?: DisplayProperty[];
  respondWith?: {
    filter: RequestFilter;
    handler: (request: Request, context: RequestContext) => Promise<Response>;
  };
  verify: (request: Request, context: RequestContext) => Promise<boolean>;
  /** Use this if you want to control the events created.  */
  transform?: (request: Request, context: RequestContext) => Promise<SendEvent[]>;
};

type HttpRequest<TBody> = {
  headers: Record<string, string>;
  method: HttpMethod;
  searchParams: Record<string, string>;
  body: TBody;
};

/** `eventTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to subscribe to an event a Job from [a sent event](https://trigger.dev/docs/sdk/triggerclient/instancemethods/sendevent)
 * @param options options for the EventTrigger
 */
export function httpTrigger<TEvent extends any = any>(
  options: HttpTriggerOptions<TEvent>
): Trigger<EventSpecification<Prettify<HttpRequest<TEvent>>>> {
  return new HttpTrigger({
    id: options.id,
    event: {
      name: options.id,
      title: options.title ?? "HTTP Trigger",
      source: options.hostname,
      icon: options.icon ?? "world-www",
      properties: options.properties,
      examples: options.examples,
      parsePayload: (rawPayload: any) => {
        if (options.bodySchema) {
          const result = options.bodySchema.safeParse(rawPayload.body);

          if (!result.success) {
            throw new ParsedPayloadSchemaError(formatSchemaErrors(result.error.issues));
          }

          return {
            headers: rawPayload.headers,
            method: rawPayload.method,
            searchParams: rawPayload.searchParams,
            body: result.data,
          };
        }

        return rawPayload as any;
      },
    },
  });
}
