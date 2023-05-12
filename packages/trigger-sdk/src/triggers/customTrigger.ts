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
    name: string;
    event: TEventSpecification;
    source?: string;
    filter?: EventFilter;
  };

class CustomTrigger<TEventSpecification extends EventSpecification<any>>
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
        title: this.#options.name,
        rule: {
          event: this.#options.name,
          source: this.#options.source ?? "trigger.dev",
          payload: deepMergeFilters(
            this.#options.filter ?? {},
            this.#options.event.filter ?? {}
          ),
        },
      },
    ];
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
  schema,
  source,
}: {
  schema: z.Schema<TEvent>;
  source?: string;
}): EventSpecification<TEvent> {
  return {
    name: "custom",
    title: "Custom Event",
    source: source ?? "trigger.dev",
    parsePayload: (payload: any) => {
      return schema.parse(payload);
    },
  };
}
