import { z } from "zod";
import { TaskStatusSchema } from "./tasks";

export const RunStatusSchema = z.union([
  z.literal("PENDING"),
  z.literal("QUEUED"),
  z.literal("WAITING_ON_CONNECTIONS"),
  z.literal("PREPROCESSING"),
  z.literal("STARTED"),
  z.literal("SUCCESS"),
  z.literal("FAILURE"),
  z.literal("TIMED_OUT"),
  z.literal("ABORTED"),
  z.literal("CANCELED"),
]);

export const RunTaskSchema = z.object({
  id: z.string(),
  displayKey: z.string().nullable(),
  status: TaskStatusSchema,
  name: z.string(),
  icon: z.string().nullable(),
  startedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
});

const GetRunOptionsSchema = z.object({
  subtasks: z.boolean().optional(),
  cursor: z.string().optional(),
  take: z.number().optional(),
});

export type GetRunOptions = z.infer<typeof GetRunOptionsSchema>;

export const GetRunSchema = z.object({
  id: z.string(),
  status: RunStatusSchema,
  startedAt: z.coerce.date().nullable(),
  updatedAt: z.coerce.date().nullable(),
  completedAt: z.coerce.date().nullable(),
  tasks: z.array(RunTaskSchema),
  output: z.any().optional(),
});
