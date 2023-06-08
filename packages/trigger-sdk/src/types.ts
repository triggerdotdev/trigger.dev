import type {
  EventFilter,
  Logger,
  RuntimeEnvironmentType,
  SecureString,
  TriggerMetadata,
} from "@trigger.dev/internal";
import { DisplayElement } from "@trigger.dev/internal";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";

export type { SecureString, Logger };

export interface TriggerContext {
  job: { id: string; version: string };
  environment: { slug: string; id: string; type: RuntimeEnvironmentType };
  organization: { slug: string; id: string; title: string };
  run: { id: string; isTest: boolean; startedAt: Date };
  event: { id: string; name: string; context: any; timestamp: Date };
  account?: { id: string; metadata?: any };
}

export interface TriggerPreprocessContext {
  job: { id: string; version: string };
  environment: { slug: string; id: string; type: RuntimeEnvironmentType };
  organization: { slug: string; id: string; title: string };
  run: { id: string; isTest: boolean };
  event: { id: string; name: string; context: any; timestamp: Date };
  account?: { id: string; metadata?: any };
}

export interface TaskLogger {
  debug(message: string, properties?: Record<string, any>): Promise<void>;
  info(message: string, properties?: Record<string, any>): Promise<void>;
  warn(message: string, properties?: Record<string, any>): Promise<void>;
  error(message: string, properties?: Record<string, any>): Promise<void>;
}

export type PreprocessResults = {
  abort: boolean;
  elements: DisplayElement[];
};

export type TriggerEventType<TTrigger extends Trigger<any>> =
  TTrigger extends Trigger<infer TEventSpec>
    ? ReturnType<TEventSpec["parsePayload"]>
    : never;

export interface Trigger<TEventSpec extends EventSpecification<any>> {
  event: TEventSpec;
  toJSON(): TriggerMetadata;
  // Attach this trigger to the job and the trigger client
  // Gives different triggers the ability to do things like register internal jobs
  attachToJob(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventSpec>, any>
  ): void;

  preprocessRuns: boolean;
}

export interface EventSpecification<TEvent extends any> {
  name: string;
  title: string;
  source: string;
  icon: string;
  elements?: DisplayElement[];
  schema?: any;
  examples?: Array<TEvent>;
  filter?: EventFilter;
  parsePayload: (payload: unknown) => TEvent;
  runElements?: (payload: TEvent) => DisplayElement[];
}

export type EventTypeFromSpecification<
  TEventSpec extends EventSpecification<any>
> = TEventSpec extends EventSpecification<infer TEvent> ? TEvent : never;
