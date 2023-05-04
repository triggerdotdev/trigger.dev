import type {
  ApiEventLog,
  RawEvent,
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
  TTrigger extends Trigger<infer TEventType> ? TEventType : never;

export interface Trigger<TEventType = any> {
  eventElements(event: ApiEventLog): DisplayElement[];
  toJSON(): TriggerMetadata;
  parsePayload(payload: unknown): TEventType;

  // Attach this trigger to the job and the trigger client
  // Gives different triggers the ability to do things like register internal jobs
  attach(
    triggerClient: TriggerClient,
    job: Job<Trigger<TEventType>, any>,
    variantId?: string
  ): void;
}
