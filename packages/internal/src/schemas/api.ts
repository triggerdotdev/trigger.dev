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

export const UpdateTriggerSourceBodySchema = z.object({
  registeredEvents: z.array(z.string()),
  secret: z.string().optional(),
  data: SerializableJsonSchema.optional(),
});

export type UpdateTriggerSourceBody = z.infer<
  typeof UpdateTriggerSourceBodySchema
>;

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
  "x-ts-http-headers": z
    .string()
    .transform((s) => z.record(z.string()).parse(JSON.parse(s))),
});

export type HttpSourceRequestHeaders = z.output<
  typeof HttpSourceRequestHeadersSchema
>;

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
  queue: z.union([QueueOptionsSchema, z.string()]).optional(),
  startPosition: z.enum(["initial", "latest"]),
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
});

export type SourceMetadata = z.infer<typeof SourceMetadataSchema>;

export const DynamicTriggerEndpointMetadataSchema = z.object({
  id: z.string(),
  jobs: z.array(JobMetadataSchema.pick({ id: true, version: true })),
});

export type DynamicTriggerEndpointMetadata = z.infer<
  typeof DynamicTriggerEndpointMetadataSchema
>;

export const IndexEndpointResponseSchema = z.object({
  jobs: z.array(JobMetadataSchema),
  sources: z.array(SourceMetadataSchema),
  dynamicTriggers: z.array(DynamicTriggerEndpointMetadataSchema),
  dynamicSchedules: z.array(RegisterDynamicSchedulePayloadSchema),
});

export type IndexEndpointResponse = z.infer<typeof IndexEndpointResponseSchema>;

export const RawEventSchema = z.object({
  id: z.string().default(() => ulid()),
  name: z.string(),
  source: z.string().optional(),
  payload: z.any(),
  context: z.any().optional(),
  timestamp: z.string().datetime().optional(),
});

export type RawEvent = z.infer<typeof RawEventSchema>;
export type SendEvent = z.input<typeof RawEventSchema>;

export const ApiEventLogSchema = z.object({
  id: z.string(),
  name: z.string(),
  payload: DeserializedJsonSchema,
  context: DeserializedJsonSchema.optional().nullable(),
  timestamp: z.coerce.date(),
  deliverAt: z.coerce.date().optional().nullable(),
  deliveredAt: z.coerce.date().optional().nullable(),
});

export type ApiEventLog = z.infer<typeof ApiEventLogSchema>;

export const SendEventOptionsSchema = z.object({
  deliverAt: z.string().datetime().optional(),
  deliverAfter: z.number().int().optional(),
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

export type RuntimeEnvironmentType = z.infer<
  typeof RuntimeEnvironmentTypeSchema
>;

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

export const RunJobSuccessSchema = z.object({
  status: z.literal("SUCCESS"),
  output: DeserializedJsonSchema.optional(),
});

export type RunJobSuccess = z.infer<typeof RunJobSuccessSchema>;

export const RunJobResponseSchema = z.discriminatedUnion("status", [
  RunJobErrorSchema,
  RunJobResumeWithTaskSchema,
  RunJobRetryWithTaskSchema,
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
  limit: z.number().optional(),
  factor: z.number().optional(),
  minTimeoutInMs: z.number().optional(),
  maxTimeoutInMs: z.number().optional(),
  randomize: z.boolean().optional(),
});

export type RetryOptions = z.infer<typeof RetryOptionsSchema>;

export const RunTaskOptionsSchema = z.object({
  name: z.string(),
  icon: z.string().optional(),
  displayKey: z.string().optional(),
  noop: z.boolean().default(false),
  operation: z.enum(["fetch"]).optional(),
  delayUntil: z.coerce.date().optional(),
  description: z.string().optional(),
  properties: z.array(DisplayPropertySchema).optional(),
  params: z.any(),
  trigger: TriggerMetadataSchema.optional(),
  redact: RedactSchema.optional(),
  connectionKey: z.string().optional(),
  style: StyleSchema.optional(),
  retry: RetryOptionsSchema.optional(),
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

export type CompleteTaskBodyInput = z.input<typeof CompleteTaskBodyInputSchema>;
export type CompleteTaskBodyOutput = z.infer<
  typeof CompleteTaskBodyInputSchema
>;

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
  metadata: z.any().optional()
});

export type InitializeTriggerBody = z.infer<typeof InitializeTriggerBodySchema>;

const RegisterCommonScheduleBodySchema = z.object({
  id: z.string(),
  metadata: z.any(),
  accountId: z.string().optional(),
});

export const RegisterIntervalScheduleBodySchema =
  RegisterCommonScheduleBodySchema.merge(IntervalMetadataSchema);

export type RegisterIntervalScheduleBody = z.infer<
  typeof RegisterIntervalScheduleBodySchema
>;

export const InitializeCronScheduleBodySchema =
  RegisterCommonScheduleBodySchema.merge(CronMetadataSchema);

export type RegisterCronScheduleBody = z.infer<
  typeof InitializeCronScheduleBodySchema
>;

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

export type RegisterScheduleResponseBody = z.infer<
  typeof RegisterScheduleResponseBodySchema
>;

export const CreateExternalConnectionBodySchema = z.object({
  accessToken: z.string(),
  type: z.enum(["oauth2"]),
  scopes: z.array(z.string()).optional(),
  metadata: z.any(),
});

export type CreateExternalConnectionBody = z.infer<
  typeof CreateExternalConnectionBodySchema
>;
