import { z } from "zod";
import { DeserializedJsonSchema, SerializableJsonSchema } from "./json";

export const DisplayPropertySchema = z.object({
  label: z.string(),
  value: z.string(),
});

export type DisplayProperty = z.infer<typeof DisplayPropertySchema>;

export const TaskStatusSchema = z.enum([
  "PENDING",
  "WAITING",
  "RUNNING",
  "COMPLETED",
  "ERRORED",
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TaskSchema = z.object({
  id: z.string(),
  name: z.string(),
  noop: z.boolean().default(false),
  startedAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  delayUntil: z.coerce.date().optional().nullable(),
  status: TaskStatusSchema,
  description: z.string().optional().nullable(),
  displayProperties: z
    .array(
      z.object({
        label: z.string(),
        value: z.string(),
      })
    )
    .optional()
    .nullable(),
  params: DeserializedJsonSchema.optional().nullable(),
  output: DeserializedJsonSchema.optional().nullable(),
  error: z.string().optional().nullable(),
});

export const ServerTaskSchema = TaskSchema.extend({
  idempotencyKey: z.string(),
});

export const CachedTaskSchema = z.object({
  id: z.string(),
  idempotencyKey: z.string(),
  status: TaskStatusSchema,
  noop: z.boolean().default(false),
  output: DeserializedJsonSchema.optional().nullable(),
});
