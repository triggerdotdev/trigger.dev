import { ulid } from "ulid";
import { z } from "zod";
import { ErrorWithStackSchema } from "./errors";
import { EventRuleSchema } from "./eventFilter";
import { ConnectionAuthSchema, IntegrationConfigSchema } from "./integrations";
import { DeserializedJsonSchema, SerializableJsonSchema } from "./json";
import { DisplayPropertySchema, StyleSchema } from "./properties";
import {
  CronMetadataSchema,
  IntervalMetadataSchema,
  RegisterDynamicSchedulePayloadSchema,
  ScheduleMetadataSchema,
} from "./schedules";
import { CachedTaskSchema, ServerTaskSchema, TaskSchema } from "./tasks";
import { EventSpecificationSchema, TriggerMetadataSchema } from "./triggers";
import { Prettify } from "../types";

export const UpdateTriggerSourceBodySchema = z.object({
  registeredEvents: z.array(z.string()),
  secret: z.string().optional(),
  data: SerializableJsonSchema.optional(),
});

export type UpdateTriggerSourceBody = z.infer<typeof UpdateTriggerSourceBodySchema>;

export const HttpEventSourceSchema = UpdateTriggerSourceBodySchema.extend({
  id: z.string(),
  active: z.boolean(),
  url: z.string().url(),
});

export const RegisterHTTPTriggerSourceBodySchema = z.object({
  type: z.literal("HTTP"),
  url: z.string().url(),
});

export const RegisterSMTPTriggerSourceBodySchema = z.object({
  type: z.literal("SMTP"),
});

export const RegisterSQSTriggerSourceBodySchema = z.object({
  type: z.literal("SQS"),
});

export const RegisterSourceChannelBodySchema = z.discriminatedUnion("type", [
  RegisterHTTPTriggerSourceBodySchema,
  RegisterSMTPTriggerSourceBodySchema,
  RegisterSQSTriggerSourceBodySchema,
]);

export const REGISTER_SOURCE_EVENT = "dev.trigger.source.register";

export const RegisterTriggerSourceSchema = z.object({
  key: z.string(),
  params: z.any(),
  active: z.boolean(),
  secret: z.string(),
  data: DeserializedJsonSchema.optional(),
  channel: RegisterSourceChannelBodySchema,
  clientId: z.string().optional(),
});

export type RegisterTriggerSource = z.infer<typeof RegisterTriggerSourceSchema>;

export const RegisterSourceEventSchema = z.object({
  /** The id of the source */
  id: z.string(),
  source: RegisterTriggerSourceSchema,
  events: z.array(z.string()),
  missingEvents: z.array(z.string()),
  orphanedEvents: z.array(z.string()),
  dynamicTriggerId: z.string().optional(),
});

export type RegisterSourceEvent = z.infer<typeof RegisterSourceEventSchema>;

export const TriggerSourceSchema = z.object({
  id: z.string(),
  key: z.string(),
});

export const HandleTriggerSourceSchema = z.object({
  key: z.string(),
  secret: z.string(),
  data: z.any(),
  params: z.any(),
});

export type HandleTriggerSource = z.infer<typeof HandleTriggerSourceSchema>;

export type TriggerSource = z.infer<typeof TriggerSourceSchema>;

export const HttpSourceRequestSchema = z.object({
  url: z.string().url(),
  method: z.string(),
  headers: z.record(z.string()),
  rawBody: z.instanceof(Buffer).optional().nullable(),
});

export type HttpSourceRequest = z.infer<typeof HttpSourceRequestSchema>;

export const HttpSourceRequestHeadersSchema = z.object({
  "x-ts-key": z.string(),
  "x-ts-dynamic-id": z.string().optional(),
  "x-ts-secret": z.string(),
  "x-ts-data": z.string().transform((s) => JSON.parse(s)),
  "x-ts-params": z.string().transform((s) => JSON.parse(s)),
  "x-ts-http-url": z.string(),
  "x-ts-http-method": z.string(),
  "x-ts-http-headers": z.string().transform((s) => z.record(z.string()).parse(JSON.parse(s))),
});

export type HttpSourceRequestHeaders = z.output<typeof HttpSourceRequestHeadersSchema>;

export const PongSuccessResponseSchema = z.object({
  ok: z.literal(true),
});

export const PongErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const PongResponseSchema = z.discriminatedUnion("ok", [
  PongSuccessResponseSchema,
  PongErrorResponseSchema,
]);

export type PongResponse = z.infer<typeof PongResponseSchema>;

export const ValidateSuccessResponseSchema = z.object({
  ok: z.literal(true),
  endpointId: z.string(),
});

export const ValidateErrorResponseSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const ValidateResponseSchema = z.discriminatedUnion("ok", [
  ValidateSuccessResponseSchema,
  ValidateErrorResponseSchema,
]);

export type ValidateResponse = z.infer<typeof ValidateResponseSchema>;

export const QueueOptionsSchema = z.object({
  name: z.string(),
  maxConcurrent: z.number().optional(),
});

export type QueueOptions = z.infer<typeof QueueOptionsSchema>;

export const JobMetadataSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  event: EventSpecificationSchema,
  trigger: TriggerMetadataSchema,
  integrations: z.record(IntegrationConfigSchema),
  internal: z.boolean().default(false),
  enabled: z.boolean(),
  preprocessRuns: z.boolean(),
});

export type JobMetadata = z.infer<typeof JobMetadataSchema>;

export const SourceMetadataSchema = z.object({
  channel: z.enum(["HTTP", "SQS", "SMTP"]),
  integration: IntegrationConfigSchema,
  key: z.string(),
  params: z.any(),
  events: z.array(z.string()),
  registerSourceJob: z
    .object({
      id: z.string(),
      version: z.string(),
    })
    .optional(),
});

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export const DynamicTriggerEndpointMetadataSchema = z.object({
  id: z.string(),
  jobs: z.array(JobMetadataSchema.pick({ id: true, version: true })),
  registerSourceJob: z
    .object({
      id: z.string(),
      version: z.string(),
    })
    .optional(),
});

export type DynamicTriggerEndpointMetadata = z.infer<typeof DynamicTriggerEndpointMetadataSchema>;

export const IndexEndpointResponseSchema = z.object({
  jobs: z.array(JobMetadataSchema),
  sources: z.array(SourceMetadataSchema),
  dynamicTriggers: z.array(DynamicTriggerEndpointMetadataSchema),
  dynamicSchedules: z.array(RegisterDynamicSchedulePayloadSchema),
});

export type IndexEndpointResponse = z.infer<typeof IndexEndpointResponseSchema>;

export const RawEventSchema = z.object({
  /** The `name` property must exactly match any subscriptions you want to
      trigger. */
  name: z.string(),
  /** The `payload` property will be sent to any matching Jobs and will appear
      as the `payload` param of the `run()` function. You can leave this
      parameter out if you just want to trigger a Job without any input data. */
  payload: z.any(),
  /** The optional `context` property will be sent to any matching Jobs and will
      be passed through as the `context.event.context` param of the `run()`
      function. This is optional but can be useful if you want to pass through
      some additional context to the Job. */
  context: z.any().optional(),
  /** The `id` property uniquely identify this particular event. If unset it
      will be set automatically using `ulid`. */
  id: z.string().default(() => ulid()),
  /** This is optional, it defaults to the current timestamp. Usually you would
      only set this if you have a timestamp that you wish to pass through, e.g.
      you receive a timestamp from a service and you want the same timestamp to
      be used in your Job. */
  timestamp: z.coerce.date().optional(),
  /** This is optional, it defaults to "trigger.dev". It can be useful to set
      this as you can filter events using this in the `eventTrigger()`. */
  source: z.string().optional(),
});

export type RawEvent = z.infer<typeof RawEventSchema>;

/** The event you wish to send to Trigger a Job */
export type SendEvent = z.input<typeof RawEventSchema>;

/** The event that was sent */
export const ApiEventLogSchema = z.object({
  /** The `id` of the event that was sent.
   */
  id: z.string(),
  /** The `name` of the event that was sent. */
  name: z.string(),
  /** The `payload` of the event that was sent */
  payload: DeserializedJsonSchema,
  /** The `context` of the event that was sent. Is `undefined` if no context was
      set when sending the event. */
  context: DeserializedJsonSchema.optional().nullable(),
  /** The `timestamp` of the event that was sent */
  timestamp: z.coerce.date(),
  /** The timestamp when the event will be delivered to any matching Jobs. Is
      `undefined` if `deliverAt` or `deliverAfter` wasn't set when sending the
      event. */
  deliverAt: z.coerce.date().optional().nullable(),
  /** The timestamp when the event was delivered. Is `undefined` if `deliverAt`
      or `deliverAfter` were set when sending the event. */
  deliveredAt: z.coerce.date().optional().nullable(),
});

export type ApiEventLog = z.infer<typeof ApiEventLogSchema>;

/** Options to control the delivery of the event */
export const SendEventOptionsSchema = z.object({
  /** An optional Date when you want the event to trigger Jobs. The event will
      be sent to the platform immediately but won't be acted upon until the
      specified time. */
  deliverAt: z.coerce.date().optional(),
  /** An optional number of seconds you want to wait for the event to trigger
      any relevant Jobs. The event will be sent to the platform immediately but
      won't be delivered until after the elapsed number of seconds. */
  deliverAfter: z.number().int().optional(),
  /** This optional param will be used by Trigger.dev Connect, which
      is coming soon. */
  accountId: z.string().optional(),
});

export const SendEventBodySchema = z.object({
  event: RawEventSchema,
  options: SendEventOptionsSchema.optional(),
});

export type SendEventBody = z.infer<typeof SendEventBodySchema>;
export type SendEventOptions = z.infer<typeof SendEventOptionsSchema>;

export const DeliverEventResponseSchema = z.object({
  deliveredAt: z.string().datetime(),
});

export type DeliverEventResponse = z.infer<typeof DeliverEventResponseSchema>;

export const RuntimeEnvironmentTypeSchema = z.enum([
  "PRODUCTION",
  "STAGING",
  "DEVELOPMENT",
  "PREVIEW",
]);

export type RuntimeEnvironmentType = z.infer<typeof RuntimeEnvironmentTypeSchema>;

export const RunSourceContextSchema = z.object({
  id: z.string(),
  metadata: z.any(),
});

export const RunJobBodySchema = z.object({
  event: ApiEventLogSchema,
  job: z.object({
    id: z.string(),
    version: z.string(),
  }),
  run: z.object({
    id: z.string(),
    isTest: z.boolean(),
    isRetry: z.boolean().default(false),
    startedAt: z.coerce.date(),
  }),
  environment: z.object({
    id: z.string(),
    slug: z.string(),
    type: RuntimeEnvironmentTypeSchema,
  }),
  organization: z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
  }),
  account: z
    .object({
      id: z.string(),
      metadata: z.any(),
    })
    .optional(),
  source: RunSourceContextSchema.optional(),
  tasks: z.array(CachedTaskSchema).optional(),
  connections: z.record(ConnectionAuthSchema).optional(),
});

export type RunJobBody = z.infer<typeof RunJobBodySchema>;

export const RunJobErrorSchema = z.object({
  status: z.literal("ERROR"),
  error: ErrorWithStackSchema,
  task: TaskSchema.optional(),
});

export type RunJobError = z.infer<typeof RunJobErrorSchema>;

export const RunJobResumeWithTaskSchema = z.object({
  status: z.literal("RESUME_WITH_TASK"),
  task: TaskSchema,
});

export type RunJobResumeWithTask = z.infer<typeof RunJobResumeWithTaskSchema>;

export const RunJobRetryWithTaskSchema = z.object({
  status: z.literal("RETRY_WITH_TASK"),
  task: TaskSchema,
  error: ErrorWithStackSchema,
  retryAt: z.coerce.date(),
});

export type RunJobRetryWithTask = z.infer<typeof RunJobRetryWithTaskSchema>;

export const RunJobCanceledWithTaskSchema = z.object({
  status: z.literal("CANCELED"),
  task: TaskSchema,
});

export type RunJobCanceledWithTask = z.infer<typeof RunJobCanceledWithTaskSchema>;

export const RunJobSuccessSchema = z.object({
  status: z.literal("SUCCESS"),
  output: DeserializedJsonSchema.optional(),
});

export type RunJobSuccess = z.infer<typeof RunJobSuccessSchema>;

export const RunJobResponseSchema = z.discriminatedUnion("status", [
  RunJobErrorSchema,
  RunJobResumeWithTaskSchema,
  RunJobRetryWithTaskSchema,
  RunJobCanceledWithTaskSchema,
  RunJobSuccessSchema,
]);

export type RunJobResponse = z.infer<typeof RunJobResponseSchema>;

export const PreprocessRunBodySchema = z.object({
  event: ApiEventLogSchema,
  job: z.object({
    id: z.string(),
    version: z.string(),
  }),
  run: z.object({
    id: z.string(),
    isTest: z.boolean(),
  }),
  environment: z.object({
    id: z.string(),
    slug: z.string(),
    type: RuntimeEnvironmentTypeSchema,
  }),
  organization: z.object({
    id: z.string(),
    title: z.string(),
    slug: z.string(),
  }),
  account: z
    .object({
      id: z.string(),
      metadata: z.any(),
    })
    .optional(),
});

export type PreprocessRunBody = z.infer<typeof PreprocessRunBodySchema>;

export const PreprocessRunResponseSchema = z.object({
  abort: z.boolean(),
  properties: z.array(DisplayPropertySchema).optional(),
});

export type PreprocessRunResponse = z.infer<typeof PreprocessRunResponseSchema>;

export const CreateRunBodySchema = z.object({
  client: z.string(),
  job: JobMetadataSchema,
  event: ApiEventLogSchema,
  properties: z.array(DisplayPropertySchema).optional(),
});

export type CreateRunBody = z.infer<typeof CreateRunBodySchema>;

const CreateRunResponseOkSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    id: z.string(),
  }),
});

const CreateRunResponseErrorSchema = z.object({
  ok: z.literal(false),
  error: z.string(),
});

export const CreateRunResponseBodySchema = z.discriminatedUnion("ok", [
  CreateRunResponseOkSchema,
  CreateRunResponseErrorSchema,
]);

export type CreateRunResponseBody = z.infer<typeof CreateRunResponseBodySchema>;

export const RedactStringSchema = z.object({
  __redactedString: z.literal(true),
  strings: z.array(z.string()),
  interpolations: z.array(z.string()),
});

export type RedactString = z.infer<typeof RedactStringSchema>;

export const LogMessageSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  message: z.string(),
  data: SerializableJsonSchema.optional(),
});

export type LogMessage = z.infer<typeof LogMessageSchema>;

export type ClientTask = z.infer<typeof TaskSchema>;
export type CachedTask = z.infer<typeof CachedTaskSchema>;

export const RedactSchema = z.object({
  paths: z.array(z.string()),
});

export const RetryOptionsSchema = z.object({
  /** The maximum number of times to retry the request. */
  limit: z.number().optional(),
  /** The exponential factor to use when calculating the next retry time. */
  factor: z.number().optional(),
  /** The minimum amount of time to wait before retrying the request. */
  minTimeoutInMs: z.number().optional(),
  /** The maximum amount of time to wait before retrying the request. */
  maxTimeoutInMs: z.number().optional(),
  /** Whether to randomize the retry time. */
  randomize: z.boolean().optional(),
});

export type RetryOptions = z.infer<typeof RetryOptionsSchema>;

export const RunTaskOptionsSchema = z.object({
  /** The name of the Task is required. This is displayed on the Task in the logs. */
  name: z.string(),
  /** The Task will wait and only start at the specified Date  */
  delayUntil: z.coerce.date().optional(),
  /** Retry options */
  retry: RetryOptionsSchema.optional(),
  /** The icon for the Task, it will appear in the logs.
   *  You can use the name of a company in lowercase, e.g. "github".
   *  Or any icon name that [Font Awesome](https://fontawesome.com/icons) supports. */
  icon: z.string().optional(),
  /** The key for the Task that you want to appear in the logs */
  displayKey: z.string().optional(),
  /** A description of the Task */
  description: z.string().optional(),
  /** Properties that are displayed in the logs */
  properties: z.array(DisplayPropertySchema).optional(),
  /** The input params to the Task, will be displayed in the logs  */
  params: z.any(),
  /** The style of the log entry. */
  style: StyleSchema.optional(),
  /** Allows you to link the Integration connection in the logs. This is handled automatically in integrations.  */
  connectionKey: z.string().optional(),
  /** An operation you want to perform on the Trigger.dev platform, current only "fetch" is supported. If you wish to `fetch` use [`io.backgroundFetch()`](https://trigger.dev/docs/sdk/io/backgroundfetch) instead. */
  operation: z.enum(["fetch"]).optional(),
  /** A No Operation means that the code won't be executed. This is used internally to implement features like [io.wait()](https://trigger.dev/docs/sdk/io/wait).  */
  noop: z.boolean().default(false),
  redact: RedactSchema.optional(),
  trigger: TriggerMetadataSchema.optional(),
});

export type RunTaskOptions = z.input<typeof RunTaskOptionsSchema>;

export const RunTaskBodyInputSchema = RunTaskOptionsSchema.extend({
  idempotencyKey: z.string(),
  parentId: z.string().optional(),
});

export type RunTaskBodyInput = z.infer<typeof RunTaskBodyInputSchema>;

export const RunTaskBodyOutputSchema = RunTaskBodyInputSchema.extend({
  params: DeserializedJsonSchema.optional().nullable(),
});

export type RunTaskBodyOutput = z.infer<typeof RunTaskBodyOutputSchema>;

export const CompleteTaskBodyInputSchema = RunTaskBodyInputSchema.pick({
  properties: true,
  description: true,
  params: true,
}).extend({
  output: SerializableJsonSchema.optional().transform((v) =>
    v ? DeserializedJsonSchema.parse(JSON.parse(JSON.stringify(v))) : {}
  ),
});

export type CompleteTaskBodyInput = Prettify<z.input<typeof CompleteTaskBodyInputSchema>>;
export type CompleteTaskBodyOutput = z.infer<typeof CompleteTaskBodyInputSchema>;

export const FailTaskBodyInputSchema = z.object({
  error: ErrorWithStackSchema,
});

export type FailTaskBodyInput = z.infer<typeof FailTaskBodyInputSchema>;

export const NormalizedRequestSchema = z.object({
  headers: z.record(z.string()),
  method: z.string(),
  query: z.record(z.string()),
  url: z.string(),
  body: z.any(),
});

export type NormalizedRequest = z.infer<typeof NormalizedRequestSchema>;

export const NormalizedResponseSchema = z.object({
  status: z.number(),
  body: z.any(),
  headers: z.record(z.string()).optional(),
});

export type NormalizedResponse = z.infer<typeof NormalizedResponseSchema>;

export const HttpSourceResponseSchema = z.object({
  response: NormalizedResponseSchema,
  events: z.array(RawEventSchema),
});

export const RegisterTriggerBodySchema = z.object({
  rule: EventRuleSchema,
  source: SourceMetadataSchema,
});

export type RegisterTriggerBody = z.infer<typeof RegisterTriggerBodySchema>;

export const InitializeTriggerBodySchema = z.object({
  id: z.string(),
  params: z.any(),
  accountId: z.string().optional(),
  metadata: z.any().optional(),
});

export type InitializeTriggerBody = z.infer<typeof InitializeTriggerBodySchema>;

const RegisterCommonScheduleBodySchema = z.object({
  /** A unique id for the schedule. This is used to identify and unregister the schedule later. */
  id: z.string(),
  /** Any additional metadata about the schedule. */
  metadata: z.any(),
  /** This will be used by the Trigger.dev Connect feature, which is coming soon. */
  accountId: z.string().optional(),
});

export const RegisterIntervalScheduleBodySchema =
  RegisterCommonScheduleBodySchema.merge(IntervalMetadataSchema);

export type RegisterIntervalScheduleBody = z.infer<typeof RegisterIntervalScheduleBodySchema>;

export const InitializeCronScheduleBodySchema =
  RegisterCommonScheduleBodySchema.merge(CronMetadataSchema);

export type RegisterCronScheduleBody = z.infer<typeof InitializeCronScheduleBodySchema>;

export const RegisterScheduleBodySchema = z.discriminatedUnion("type", [
  RegisterIntervalScheduleBodySchema,
  InitializeCronScheduleBodySchema,
]);

export type RegisterScheduleBody = z.infer<typeof RegisterScheduleBodySchema>;

export const RegisterScheduleResponseBodySchema = z.object({
  id: z.string(),
  schedule: ScheduleMetadataSchema,
  metadata: z.any(),
  active: z.boolean(),
});

export type RegisterScheduleResponseBody = z.infer<typeof RegisterScheduleResponseBodySchema>;

export const CreateExternalConnectionBodySchema = z.object({
  accessToken: z.string(),
  type: z.enum(["oauth2"]),
  scopes: z.array(z.string()).optional(),
  metadata: z.any(),
});

export type CreateExternalConnectionBody = z.infer<typeof CreateExternalConnectionBodySchema>;
