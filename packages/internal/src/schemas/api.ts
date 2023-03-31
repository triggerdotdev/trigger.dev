import { z } from "zod";
import { DeserializedJsonSchema, SerializableJsonSchema } from "./json";
import { CachedTaskSchema, ServerTaskSchema, TaskSchema } from "./tasks";
import { TriggerMetadataSchema } from "./triggers";
import { ulid } from "ulid";

export const PongResponseSchema = z.object({
  message: z.literal("PONG"),
});

export const JobSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  trigger: TriggerMetadataSchema,
});

export type ApiJob = z.infer<typeof JobSchema>;

export const GetJobResponseSchema = z.object({
  job: JobSchema,
});

export const GetJobsResponseSchema = z.object({
  jobs: z.array(JobSchema),
});

export const RawEventSchema = z.object({
  id: z.string().default(() => ulid()),
  name: z.string(),
  source: z.string().default("trigger.dev"),
  payload: DeserializedJsonSchema,
  context: DeserializedJsonSchema.optional(),
  timestamp: z.string().datetime().optional(),
});

export type RawEvent = z.infer<typeof RawEventSchema>;
export type SendEvent = z.input<typeof RawEventSchema>;

export const ApiEventLogSchema = z.object({
  id: z.string(),
  name: z.string(),
  source: z.string(),
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

export const ExecuteJobBodySchema = z.object({
  event: ApiEventLogSchema,
  job: z.object({
    id: z.string(),
    version: z.string(),
  }),
  context: z.object({
    id: z.string(),
    environment: z.string(),
    organization: z.string(),
    isTest: z.boolean(),
    version: z.string(),
    startedAt: z.coerce.date(),
  }),
  tasks: z.array(CachedTaskSchema).optional(),
});

export type ExecuteJobBody = z.infer<typeof ExecuteJobBodySchema>;

export const ExecuteJobResponseSchema = z.object({
  executionId: z.string(),
  completed: z.boolean(),
  output: DeserializedJsonSchema.optional(),
  task: TaskSchema.optional(),
});

export type ExecuteJobResponse = z.infer<typeof ExecuteJobResponseSchema>;

export const CreateExecutionBodySchema = z.object({
  client: z.string(),
  job: JobSchema,
  event: ApiEventLogSchema,
});

export type CreateExecutionBody = z.infer<typeof CreateExecutionBodySchema>;

export const SecureStringSchema = z.object({
  __secureString: z.literal(true),
  strings: z.array(z.string()),
  interpolations: z.array(z.string()),
});

export type SecureString = z.infer<typeof SecureStringSchema>;

export const LogMessageSchema = z.object({
  level: z.enum(["DEBUG", "INFO", "WARN", "ERROR"]),
  message: z.string(),
  data: SerializableJsonSchema.optional(),
});

export type LogMessage = z.infer<typeof LogMessageSchema>;

export type ClientTask = z.infer<typeof TaskSchema>;
export type ServerTask = z.infer<typeof ServerTaskSchema>;
export type CachedTask = z.infer<typeof CachedTaskSchema>;

export const IOTaskSchema = z.object({
  name: z.string(),
  ts: z.string().default(() => String(Date.now())),
  noop: z.boolean().default(false),
  delayUntil: z.coerce.date().optional(),
  description: z.string().optional(),
  displayProperties: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    )
    .optional(),
  params: SerializableJsonSchema.optional(),
});

export type IOTask = z.input<typeof IOTaskSchema>;

export const RunTaskBodyInputSchema = IOTaskSchema.extend({
  idempotencyKey: z.string(),
});

export type RunTaskBodyInput = z.infer<typeof RunTaskBodyInputSchema>;

export const RunTaskBodyOutputSchema = RunTaskBodyInputSchema.extend({
  params: DeserializedJsonSchema.optional().nullable(),
});

export type RunTaskBodyOutput = z.infer<typeof RunTaskBodyOutputSchema>;

export const CompleteTaskBodyInputSchema = RunTaskBodyInputSchema.pick({
  displayProperties: true,
  description: true,
  params: true,
}).extend({
  output: SerializableJsonSchema.optional().transform((v) =>
    DeserializedJsonSchema.parse(JSON.parse(JSON.stringify(v)))
  ),
});

export type CompleteTaskBodyInput = z.input<typeof CompleteTaskBodyInputSchema>;
export type CompleteTaskBodyOutput = z.infer<
  typeof CompleteTaskBodyInputSchema
>;
