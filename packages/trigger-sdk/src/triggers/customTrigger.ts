import { z } from "zod";
import { Job } from "../job";
import { TriggerClient } from "../triggerClient";
import { EventSpecification, Trigger } from "../types";
import {
  EventFilter,
  TriggerMetadata,
  deepMergeFilters,
} from "@trigger.dev/internal";

type CustomTriggerOptions<TEventSpecification extends EventSpecification<any>> =
  {
    event: TEventSpecification;
    name?: string;
    source?: string;
    filter?: EventFilter;
  };

export class CustomTrigger<TEventSpecification extends EventSpecification<any>>
  implements Trigger<TEventSpecification>
{
  #options: CustomTriggerOptions<TEventSpecification>;

  constructor(options: CustomTriggerOptions<TEventSpecification>) {
    this.#options = options;
  }

  toJSON(): Array<TriggerMetadata> {
    return [
      {
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
      },
    ];
  }

  get requiresPreparaton(): boolean {
    return false;
  }

  get event() {
    return this.#options.event;
  }

  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpecification>, any>
  ): void {}
}

export function customTrigger<
  TEventSpecification extends EventSpecification<any>
>(
  options: CustomTriggerOptions<TEventSpecification>
): Trigger<TEventSpecification> {
  return new CustomTrigger(options);
}

export function customEvent<TEvent>({
  payload,
  source,
}: {
  payload: z.Schema<TEvent>;
  source?: string;
}): EventSpecification<TEvent> {
  return {
    name: "custom",
    title: "Custom Event",
    source: source ?? "trigger.dev",
    icon: "custom-event",
    parsePayload: (rawPayload: any) => {
      return payload.parse(rawPayload);
    },
  };
}
