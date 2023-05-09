import type {
  ApiEventLog,
  EventFilter,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { Trigger } from "../types";
import { TriggerClient } from "../triggerClient";
import { Job } from "../job";

type CustomEventTriggerOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  source?: string;
  schema?: TSchema;
  filter?: EventFilter;
};

class CustomEventTrigger<TSchema extends z.ZodTypeAny>
  implements Trigger<z.infer<TSchema>>
{
  #options: CustomEventTriggerOptions<TSchema>;

  constructor(options: CustomEventTriggerOptions<TSchema>) {
    this.#options = options;
  }

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Custom Event",
      elements: [{ label: "on", text: this.#options.name }],
      schema: this.#options.schema
        ? zodToJsonSchema(this.#options.schema)
        : undefined,
      eventRule: {
        event: this.#options.name,
        source: this.#options.source ?? "trigger.dev",
        payload: this.#options.filter ?? {},
      },
    };
  }

  parsePayload(payload: unknown): z.infer<TSchema> {
    if (!this.#options.schema) {
      return payload;
    }

    return this.#options.schema.parse(payload);
  }

  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<z.infer<TSchema>>, any>,
    variantId?: string
  ): void {}
}

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: CustomEventTriggerOptions<TSchema>
): Trigger<z.infer<TSchema>> {
  return new CustomEventTrigger(options);
}
