import {
  BatcherOptions,
  EventFilter,
  OptionalBatcherOptions,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/core";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import {
  EventSpecification,
  EventSpecificationExample,
  EventTypeFromSpecification,
  SchemaParser,
  Trigger,
} from "../types";
import { formatSchemaErrors } from "../utils/formatSchemaErrors";
import { ParsedPayloadSchemaError } from "../errors";
import { VerifyCallback } from "../httpEndpoint";

type EventTriggerOptions<
  TEventSpecification extends EventSpecification<any>,
  TBatcherOptions extends OptionalBatcherOptions = undefined,
> = {
  event: TEventSpecification;
  name?: string | string[];
  source?: string;
  filter?: EventFilter;
  verify?: EventTypeFromSpecification<TEventSpecification> extends Request ? VerifyCallback : never;
  batch?: TBatcherOptions;
};

export class EventTrigger<
  TEventSpecification extends EventSpecification<any>,
  TBatcherOptions extends OptionalBatcherOptions = undefined,
> implements Trigger<TEventSpecification>
{
  #options: EventTriggerOptions<TEventSpecification, TBatcherOptions>;

  constructor(options: EventTriggerOptions<TEventSpecification, TBatcherOptions>) {
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
      batch: this.#options.batch,
    };
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpecification>, any>): void {}

  /**
   * Used to configure batching options. An empty object will enable batching with server defaults.
   *
   * Batching will cause the `payload` parameter of the run function to become an array of payloads instead.
   *
   * @param options - Is an object containing the following properties:
   * @param {number} options.maxPayloads - The `maxPayloads` property defines How many event payloads you will at most receive per batch. May be reduced by server limits..
   * @param {number} options.maxInterval - The `maxInterval` property defines how many seconds to wait before sending out incomplete batches. May be cut short by server limits.
   */
  batch(options?: BatcherOptions): EventTrigger<TEventSpecification, {}> {
    const { batch, ...rest } = this.#options;

    return new EventTrigger({
      ...rest,
      batch: options ?? {},
    });
  }

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
type TriggerOptions<TEvent, TBatcherOptions extends OptionalBatcherOptions = undefined> = {
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

  /**
   * Used to configure batching options. An empty object will enable batching with server defaults.
   *
   * Batching will cause the `payload` parameter of the run function to become an array of payloads instead.
   *
   * @param {number} maxPayloads - The `maxPayloads` property defines How many event payloads you will at most receive per batch. May be reduced by server limits..
   * @param {number} maxInterval - The `maxInterval` property defines how many seconds to wait before sending out incomplete batches. May be cut short by server limits.
   */
  batch?: TBatcherOptions;

  examples?: EventSpecificationExample[];
};

/** `eventTrigger()` is set as a [Job's trigger](https://trigger.dev/docs/sdk/job) to subscribe to an event a Job from [a sent event](https://trigger.dev/docs/sdk/triggerclient/instancemethods/sendevent)
 * @param options options for the EventTrigger
 */
export function eventTrigger<
  TEvent extends any = any,
  TBatcherOptions extends OptionalBatcherOptions = undefined,
>(
  options: TriggerOptions<TEvent, TBatcherOptions>
): EventTrigger<EventSpecification<TEvent>, TBatcherOptions> {
  return new EventTrigger({
    name: options.name,
    filter: options.filter,
    batch: options.batch,
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
