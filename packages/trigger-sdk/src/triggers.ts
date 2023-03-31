import type {
  ApiEventLog,
  EventFilter,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { EventMatcher } from "./eventMatcher";

export interface Trigger<TEventType = any> {
  matches(event: ApiEventLog): boolean;
  toJSON(): TriggerMetadata;
}

export type CustomEventTriggerOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
  source?: string;
  schema?: TSchema;
  filter?: EventFilter;
};

export class CustomEventTrigger<TSchema extends z.ZodTypeAny>
  implements Trigger<z.infer<TSchema>>
{
  #options: CustomEventTriggerOptions<TSchema>;

  constructor(options: CustomEventTriggerOptions<TSchema>) {
    this.#options = options;
  }

  matches(event: ApiEventLog): boolean {
    if (event.name !== this.#options.name) {
      return false;
    }

    if (this.#options.filter || this.#options.source) {
      const eventMatcher = new EventMatcher(event);

      return eventMatcher.matches({
        name: [this.#options.name],
        source: this.#options.source ? [this.#options.source] : [],
        payload: this.#options.filter ?? {},
      });
    }

    return true;
  }

  get source(): string {
    return this.#options.source ?? "any";
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Custom Event",
      source: this.source,
      displayProperties: [{ label: "on", value: this.#options.name }],
      schema: this.#options.schema
        ? zodToJsonSchema(this.#options.schema)
        : undefined,
    };
  }
}

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: CustomEventTriggerOptions<TSchema>
): Trigger<TSchema> {
  return new CustomEventTrigger(options);
}
