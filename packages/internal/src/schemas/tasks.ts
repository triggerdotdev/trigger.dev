import { z } from "zod";
import { DisplayElementSchema } from "./elements";
import { DeserializedJsonSchema } from "./json";

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
  icon: z.string().optional(),
  noop: z.boolean().default(false),
  startedAt: z.coerce.date().optional().nullable(),
  completedAt: z.coerce.date().optional().nullable(),
  delayUntil: z.coerce.date().optional().nullable(),
  status: TaskStatusSchema,
  description: z.string().optional().nullable(),
  elements: z.array(DisplayElementSchema).optional().nullable(),
  params: DeserializedJsonSchema.optional().nullable(),
  output: DeserializedJsonSchema.optional().nullable(),
  error: z.string().optional().nullable(),
  parentId: z.string().optional().nullable(),
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
  parentId: z.string().optional().nullable(),
});
