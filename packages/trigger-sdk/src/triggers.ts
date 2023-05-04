import type {
  ApiEventLog,
  ConnectionAuth,
  ConnectionConfig,
  EventFilter,
  EventRule,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { z } from "zod";
import zodToJsonSchema from "zod-to-json-schema";
import { AnyExternalSource } from "./externalSource";
import { TriggerClient } from "./triggerClient";

export type TriggerEventType<TTrigger extends Trigger<any>> =
  TTrigger extends Trigger<infer TEventType> ? TEventType : never;

export interface Trigger<TEventType = any> {
  eventElements(event: ApiEventLog): DisplayElement[];
  toJSON(): TriggerMetadata;
  registerWith(client: TriggerClient): void;
  prepare(client: TriggerClient, auth?: ConnectionAuth): Promise<void>;
  parsePayload(payload: unknown): TEventType;
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
      supportsPreparation: false,
    };
  }

  parsePayload(payload: unknown): z.infer<TSchema> {
    if (!this.#options.schema) {
      return payload;
    }

    return this.#options.schema.parse(payload);
  }

  registerWith(client: TriggerClient) {}
  async prepare(client: TriggerClient, auth?: ConnectionAuth) {}
}

export function customEvent<TSchema extends z.ZodTypeAny>(
  options: CustomEventTriggerOptions<TSchema>
): Trigger<z.infer<TSchema>> {
  return new CustomEventTrigger(options);
}

export type ExteralSourceEventTriggerOptions<TEvent> = {
  title: string;
  eventRule: EventRule;
  elements: DisplayElement[];
  source: AnyExternalSource;
};

export class ExternalSourceEventTrigger<TEvent> implements Trigger<TEvent> {
  constructor(private options: ExteralSourceEventTriggerOptions<TEvent>) {}

  eventElements(event: ApiEventLog): DisplayElement[] {
    return this.options.source.eventElements(event);
  }

  parsePayload(payload: unknown): TEvent {
    return payload as TEvent;
  }

  toJSON(): TriggerMetadata {
    return {
      title: this.options.title,
      elements: this.options.elements,
      connection: this.connection,
      eventRule: this.options.eventRule,
      supportsPreparation: true,
    };
  }

  registerWith(client: TriggerClient) {
    client.register(this.options.source);
  }

  async prepare(client: TriggerClient, auth?: ConnectionAuth) {
    return this.options.source.prepare(client, auth);
  }

  get connection(): ConnectionConfig {
    if (this.options.source.usesLocalAuth) {
      return {
        auth: "local",
        metadata: this.options.source.connection,
      };
    } else {
      return {
        auth: "hosted",
        metadata: this.options.source.connection,
        id: this.options.source.id!,
      };
    }
  }
}
