import type {
  ApiEventLog,
  EventFilter,
  SecureString,
  SendEvent,
  SendEventOptions,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";

export type { SecureString };

export interface TriggerContext {
  id: string;
  version: string;
  environment: string;
  organization: string;
  startedAt: Date;
  isTest: boolean;
  signal: AbortSignal;
  // TODO: move this to io
  logger: TaskLogger;
  // TODO: move this to io
  wait(key: string | any[], seconds: number): Promise<void>;
  // TODO: move this to io
  sendEvent(
    key: string | any[],
    event: SendEvent,
    options?: SendEventOptions
  ): Promise<ApiEventLog>;
}

export interface TaskLogger {
  debug(message: string, properties?: Record<string, any>): Promise<void>;
  info(message: string, properties?: Record<string, any>): Promise<void>;
  warn(message: string, properties?: Record<string, any>): Promise<void>;
  error(message: string, properties?: Record<string, any>): Promise<void>;
}

export type TriggerEventType<TTrigger extends Trigger<any>> =
  TTrigger extends Trigger<infer TEventSpec>
    ? ReturnType<TEventSpec["parsePayload"]>
    : never;

export interface Trigger<TEventSpec extends EventSpecification<any>> {
  event: TEventSpec;
  toJSON(): Array<TriggerMetadata>;
  // Attach this trigger to the job and the trigger client
  // Gives different triggers the ability to do things like register internal jobs
  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpec>, any>,
    index?: number
  ): void;
  requiresPreparaton: boolean;
}

export interface EventSpecification<TEvent extends any> {
  name: string;
  title: string;
  source: string;
  elements?: DisplayElement[];
  schema?: any;
  examples?: Array<TEvent>;
  filter?: EventFilter;
  parsePayload: (payload: unknown) => TEvent;
}

export type EventTypeFromSpecification<
  TEventSpec extends EventSpecification<any>
> = TEventSpec extends EventSpecification<infer TEvent> ? TEvent : never;
