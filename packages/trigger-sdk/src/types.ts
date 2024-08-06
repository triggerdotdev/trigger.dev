import type {
  DisplayProperty,
  EventFilter,
  FailedRunNotification,
  OverridableRunTaskOptions,
  Prettify,
  RedactString,
  RegisteredOptionsDiff,
  RunTaskOptions,
  RuntimeEnvironmentType,
  SourceEventOption,
  SuccessfulRunNotification,
  TriggerMetadata,
} from "@trigger.dev/core";
import { Logger } from "@trigger.dev/core/logger";
import type TypedEmitter from "typed-emitter";
import { z } from "zod";
import { Job } from "./job";
import { TriggerClient } from "./triggerClient";

export type {
  DisplayProperty,
  Logger,
  OverridableRunTaskOptions,
  Prettify,
  RedactString,
  RegisteredOptionsDiff,
  RunTaskOptions,
  SourceEventOption,
};

export interface TriggerContext {
  /** Job metadata */
  job: { id: string; version: string };
  /** Environment metadata */
  environment: { slug: string; id: string; type: RuntimeEnvironmentType };
  /** Organization metadata */
  organization: { slug: string; id: string; title: string };
  /** Project metadata */
  project: { slug: string; id: string; name: string };
  /** Run metadata */
  run: { id: string; isTest: boolean; startedAt: Date; isRetry: boolean };
  /** Event metadata */
  event: { id: string; name: string; context: any; timestamp: Date };
  /** Source metadata */
  source?: { id: string; metadata?: any };
  /** Account metadata */
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
  properties: DisplayProperty[];
};

export type TriggerEventType<TTrigger extends Trigger<any>> = TTrigger extends Trigger<
  infer TEventSpec
>
  ? ReturnType<TEventSpec["parsePayload"]>
  : never;

export type TriggerInvokeType<TTrigger extends Trigger<any>> = TTrigger extends Trigger<
  EventSpecification<any, infer TInvoke>
>
  ? TInvoke
  : any;

export type VerifyResult =
  | {
      success: true;
    }
  | {
      success: false;
      reason?: string;
    };

export interface Trigger<TEventSpec extends EventSpecification<any>> {
  event: TEventSpec;
  toJSON(): TriggerMetadata;
  // Attach this trigger to the job and the trigger client
  // Gives different triggers the ability to do things like register internal jobs
  attachToJob(triggerClient: TriggerClient, job: Job<Trigger<TEventSpec>, any>): void;

  preprocessRuns: boolean;

  verifyPayload: (payload: ReturnType<TEventSpec["parsePayload"]>) => Promise<VerifyResult>;
}

export type TriggerPayload<TTrigger> = TTrigger extends Trigger<EventSpecification<infer TEvent>>
  ? TEvent
  : never;

export const EventSpecificationExampleSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional(),
  payload: z.any(),
});

export type EventSpecificationExample = z.infer<typeof EventSpecificationExampleSchema>;

export type TypedEventSpecificationExample<TEvent> = {
  id: string;
  name: string;
  icon?: string;
  payload: TEvent;
};

export interface EventSpecification<TEvent extends any, TInvoke extends any = TEvent> {
  name: string | string[];
  title: string;
  source: string;
  icon: string;
  properties?: DisplayProperty[];
  schema?: any;
  examples?: Array<EventSpecificationExample>;
  filter?: EventFilter;
  parsePayload: (payload: unknown) => TEvent;
  parseInvokePayload?: (payload: unknown) => TInvoke;
  runProperties?: (payload: TEvent) => DisplayProperty[];
}

export type EventTypeFromSpecification<TEventSpec extends EventSpecification<any>> =
  TEventSpec extends EventSpecification<infer TEvent> ? TEvent : never;

export type SchemaParserIssue = { path: PropertyKey[]; message: string };

export type SchemaParserResult<T> =
  | {
      success: true;
      data: T;
    }
  | { success: false; error: { issues: SchemaParserIssue[] } };

export type SchemaParser<T extends unknown = unknown> = {
  safeParse: (a: unknown) => SchemaParserResult<T>;
};

export type WaitForEventResult<TEvent> = {
  id: string;
  name: string;
  source: string;
  payload: TEvent;
  timestamp: Date;
  context?: any;
  accountId?: string;
};

export function waitForEventSchema(schema: z.ZodTypeAny) {
  return z.object({
    id: z.string(),
    name: z.string(),
    source: z.string(),
    payload: schema,
    timestamp: z.coerce.date(),
    context: z.any().optional(),
    accountId: z.string().optional(),
  });
}

export type NotificationEvents = {
  runSucceeeded: (notification: SuccessfulRunNotification<any>) => void;
  runFailed: (notification: FailedRunNotification) => void;
};

export type NotificationsEventEmitter = TypedEmitter<NotificationEvents>;
