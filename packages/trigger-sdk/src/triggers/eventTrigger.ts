import { EventFilter, TriggerMetadata, deepMergeFilters } from "@trigger.dev/core";
import { Job } from "../job.js";
import { TriggerClient } from "../triggerClient.js";
import {
  EventSpecification,
  EventSpecificationExample,
  EventTypeFromSpecification,
  SchemaParser,
  Trigger,
} from "../types.js";
import { formatSchemaErrors } from "../utils/formatSchemaErrors.js";
import { ParsedPayloadSchemaError } from "../errors.js";
import { VerifyCallback } from "../httpEndpoint.js";

type EventTriggerOptions<TEventSpecification extends EventSpecification<any>> = {
  event: TEventSpecification;
  name?: string | string[];
  source?: string;
  filter?: EventFilter;
  verify?: EventTypeFromSpecification<TEventSpecification> extends Request ? VerifyCallback : never;
};

export class EventTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  #options: EventTriggerOptions<TEventSpecification>;

  constructor(options: EventTriggerOptions<TEventSpecification>) {
    this.#options = options;
  }

  toJSON(): TriggerMetadata {
    return {
      type: "static",
      title: this.#options.name ?? this.#options.event.title,
      rule: {
        event: this.#options.name ?? this.#options.event.name,
        source: this.#options.source ?? "trigger.dev",
        payload: deepMergeFilters(this.#options.filter ?? {}, this.#options.event.filter ?? {}),
      },
    };
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

  get preprocessRuns() {
    return false;
  }

  async verifyPayload(payload: ReturnType<TEventSpecification["parsePayload"]>) {
    if (this.#options.verify) {
      if ((payload as any) instanceof Request) {
        const clonedRequest = (payload as Request).clone();
        return this.#options.verify(clonedRequest);
      }
    }

    return { success: true as const };
  }
}

/** Configuration options for an EventTrigger */
type TriggerOptions<TEvent> = {
  /** The name of the event you are subscribing to. Must be an exact match (case sensitive). To trigger on multiple possible events, pass in an array of event names */
  name: string | string[];
  /** A [Zod](https://trigger.dev/docs/documentation/guides/zod) schema that defines the shape of the event payload.
   * The default is `z.any()` which is `any`.
   * */
  schema?: SchemaParser<TEvent>;
  /** You can use this to filter events based on the source. */
  source?: string;
  /** Used to filter which events trigger the Job
   * @example
   * filter:
   * ```ts
   * {
   *    name: ["John", "Jane"],
   *    age: [18, 21]
   * }
   * ```
   *
   * This filter would match against an event with the following data:
   * ```json
   * {
   *    "name": "Jane",
   *    "age": 18,
   *    "location": "San Francisco"
   * }
   * ```
   */
  filter?: EventFilter;

  examples?: EventSpecificationExample[];
};

/** `eventTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to subscribe to an event a Job from [a sent event](https://trigger.dev/docs/sdk/triggerclient/instancemethods/sendevent)
 * @param options options for the EventTrigger
 */
export function eventTrigger<TEvent extends any = any>(
  options: TriggerOptions<TEvent>
): Trigger<EventSpecification<TEvent>> {
  return new EventTrigger({
    name: options.name,
    filter: options.filter,
    source: options.source,
    event: {
      name: options.name,
      title: "Event",
      source: options.source ?? "trigger.dev",
      icon: "custom-event",
      examples: options.examples,
      parsePayload: (rawPayload: any) => {
        if (options.schema) {
          const results = options.schema.safeParse(rawPayload);

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
