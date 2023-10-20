import {
  DisplayProperty,
  EventFilter,
  RequestFilter,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, EventSpecificationExample, SchemaParser, Trigger } from "../types";
import { formatSchemaErrors } from "../utils/formatSchemaErrors";
import { ParsedPayloadSchemaError } from "../errors";
import { z } from "zod";

type Options<TEventSpecification extends EventSpecification<any>> = {
  id: string;
  event: TEventSpecification;
};

export class HttpTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  #options: Options<TEventSpecification>;

  constructor(options: Options<TEventSpecification>) {
    this.#options = options;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "modular",
      id: "",
    };
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

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
  verify?: {
    requestFilter: RequestFilter;
    onRequest: (request: Request, context: RequestContext) => Promise<Response>;
  };
  transform?: (request: Request) => Promise<TEvent>;
};

/** `eventTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to subscribe to an event a Job from [a sent event](https://trigger.dev/docs/sdk/triggerclient/instancemethods/sendevent)
 * @param options options for the EventTrigger
 */
export function httpTrigger<TEvent extends any = any>(
  options: HttpTriggerOptions<TEvent>
): Trigger<EventSpecification<TEvent>> {
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
          const results = options.bodySchema.safeParse(rawPayload.body);

          if (!results.success) {
            throw new ParsedPayloadSchemaError(formatSchemaErrors(results.error.issues));
          }

          return results.data;
        }

        return rawPayload as any;
      },
    },
  });
}
