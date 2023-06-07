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
    name?: string;
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

type TriggerOptions<TEvent> = {
  name: string;
  schema?: z.Schema<TEvent>;
  source?: string;
  filter?: EventFilter;
};

export function eventTrigger<TEvent extends any = any>(
  options: TriggerOptions<TEvent>
): Trigger<EventSpecification<TEvent>> {
  return new EventTrigger({
    name: "Event Trigger",
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
