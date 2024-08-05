import { z } from "zod";
import { DisplayPropertySchema, StyleSchema } from "./properties.js";
import { DeserializedJsonSchema } from "./json.js";

export const TaskStatusSchema = z.enum([
  "PENDING",
  "WAITING",
  "RUNNING",
  "COMPLETED",
  "ERRORED",
  "CANCELED",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  icon: z.string().optional().nullable(),
  noop: z.boolean(),
  startedAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  delayUntil: z.coerce.date().optional().nullable(),
  status: TaskStatusSchema,
  description: z.string().optional().nullable(),
  properties: z.array(DisplayPropertySchema).optional().nullable(),
  outputProperties: z.array(DisplayPropertySchema).optional().nullable(),
  params: DeserializedJsonSchema.optional().nullable(),
  output: DeserializedJsonSchema.optional().nullable(),
  context: DeserializedJsonSchema.optional().nullable(),
  error: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
  style: StyleSchema.optional().nullable(),
  operation: z.string().optional().nullable(),
  callbackUrl: z.string().optional().nullable(),
  childExecutionMode: z.enum(["SEQUENTIAL", "PARALLEL"]).optional().nullable(),
});

export const ServerTaskSchema = TaskSchema.extend({
  idempotencyKey: z.string(),
  attempts: z.number(),
  forceYield: z.boolean().optional().nullable(),
});

export type ServerTask = z.infer<typeof ServerTaskSchema>;

export const CachedTaskSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: TaskStatusSchema,
  noop: z.boolean().default(false),
  output: DeserializedJsonSchema.optional().nullable(),
  parentId: z.string().optional().nullable(),
});
