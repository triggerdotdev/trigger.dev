import {
  EventFilter,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/internal";
import { z } from "zod";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";

type EventTriggerOptions<TEventSpecification extends EventSpecification<any>> =
  {
    event: TEventSpecification;
    name?: string | string[];
    source?: string;
    filter?: EventFilter;
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
        payload: deepMergeFilters(
          this.#options.filter ?? {},
          this.#options.event.filter ?? {}
        ),
      },
    };
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpecification>, any>
  ): void {}

  get preprocessRuns() {
    return false;
  }
}

/** Configuration options for an EventTrigger */
type TriggerOptions<TEvent> = {
  /** The name of the event you are subscribing to. Must be an exact match (case sensitive). */
  name: string | string[];
  /** A [Zod](https://trigger.dev/docs/documentation/guides/zod) schema that defines the shape of the event payload.
   * The default is `z.any()` which is `any`.
   * */
  schema?: z.Schema<TEvent>;
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
    event: {
      name: options.name,
      title: "Event",
      source: options.source ?? "trigger.dev",
      icon: "custom-event",
      parsePayload: (rawPayload: any) => {
        if (options.schema) {
          return options.schema.parse(rawPayload);
        }

        return rawPayload as any;
      },
    },
  });
}
