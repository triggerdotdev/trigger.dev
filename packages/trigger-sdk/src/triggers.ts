import type {
  ApiEventLog,
  ConnectionAuth,
  EventFilter,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { EventMatcher } from "./eventMatcher";
import { AnyExternalSource } from "./externalSource";
import { TriggerClient } from "./triggerClient";

export interface Trigger<TEventType = any> {
  matches(event: ApiEventLog): boolean;
  eventElements(event: ApiEventLog): DisplayElement[];
  toJSON(): TriggerMetadata;
  registerWith(client: TriggerClient): void;
  prepareForExecution(
    client: TriggerClient,
    auth?: ConnectionAuth
  ): Promise<void>;
  supportsPreparation: boolean;
}

export type CustomEventTriggerOptions<TSchema extends z.ZodTypeAny> = {
  name: string;
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

  eventElements(event: ApiEventLog): DisplayElement[] {
    return [];
  }

  matches(event: ApiEventLog): boolean {
    if (event.name !== this.#options.name) {
      return false;
    }

    if (this.#options.filter) {
      const eventMatcher = new EventMatcher(event);

      return eventMatcher.matches({
        name: [this.#options.name],
        payload: this.#options.filter ?? {},
      });
    }

    return true;
  }

  toJSON(): TriggerMetadata {
    return {
      title: "Custom Event",
      elements: [{ label: "on", text: this.#options.name }],
      schema: this.#options.schema
        ? zodToJsonSchema(this.#options.schema)
        : undefined,
    };
  }

  get supportsPreparation() {
    return false;
  }

  registerWith(client: TriggerClient) {}
  async prepareForExecution(client: TriggerClient, auth?: ConnectionAuth) {}
}

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: CustomEventTriggerOptions<TSchema>
): Trigger<z.infer<TSchema>> {
  return new CustomEventTrigger(options);
}

export type ExteralSourceEventTriggerOptions<TEvent> = {
  title: string;
  filter: EventFilter;
  elements: DisplayElement[];
  source: AnyExternalSource;
};

export class ExternalSourceEventTrigger<TEvent> implements Trigger<TEvent> {
  constructor(private options: ExteralSourceEventTriggerOptions<TEvent>) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return this.options.source.eventElements(event);
  }

  matches(event: ApiEventLog): boolean {
    const eventMatcher = new EventMatcher(event);

    return eventMatcher.matches(this.options.filter);
  }

  toJSON(): TriggerMetadata {
    return {
      title: this.options.title,
      elements: this.options.elements,
      connection: {
        metadata: this.options.source.connection,
        hasLocalAuth: this.options.source.hasLocalAuth,
      },
    };
  }

  registerWith(client: TriggerClient) {
    client.register(this.options.source);
  }

  get supportsPreparation() {
    return true;
  }

  async prepareForExecution(client: TriggerClient, auth?: ConnectionAuth) {
    return this.options.source.prepareForExecution(client, auth);
  }
}
