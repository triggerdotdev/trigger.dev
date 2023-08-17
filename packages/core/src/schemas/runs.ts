import { ZodObject, z } from "zod";
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
  /** The Task id */
  id: z.string(),
  /** The key that you defined when creating the Task, the first param in any task. */
  displayKey: z.string().nullable(),
  /** The Task status */
  status: TaskStatusSchema,
  /** The name of the Task */
  name: z.string(),
  /** The icon of the Task, a string.
   * For integrations, this will be a lowercase name of the company.
   * Can be used with the [@trigger.dev/companyicons](https://www.npmjs.com/package/@trigger.dev/companyicons) package to display an svg. */
  icon: z.string().nullable(),
  /** When the task started */
  startedAt: z.coerce.date().nullable(),
  /** When the task completed */
  completedAt: z.coerce.date().nullable(),
});

export type RunTaskWithSubtasks = z.infer<typeof RunTaskSchema> & {
  /** The subtasks of the task */
  subtasks?: RunTaskWithSubtasks[];
};

const RunTaskWithSubtasksSchema: z.ZodType<RunTaskWithSubtasks> = RunTaskSchema.extend({
  subtasks: z.lazy(() => RunTaskWithSubtasksSchema.array()).optional(),
});

const GetRunOptionsSchema = z.object({
  /** Return subtasks, which appear in a `subtasks` array on a task. @default false */
  subtasks: z.boolean().optional(),
  /** You can use this to get more tasks, if there are more than are returned in a single batch @default undefined */
  cursor: z.string().optional(),
  /** How many tasks you want to return in one go, max 50. @default 20 */
  take: z.number().optional(),
});

export type GetRunOptions = z.infer<typeof GetRunOptionsSchema>;

const GetRunOptionsWithTaskDetailsSchema = GetRunOptionsSchema.extend({
  /** If `true`, it returns the `params` and `output` of all tasks. @default false */
  taskdetails: z.boolean().optional(),
});

export type GetRunOptionsWithTaskDetails = z.infer<typeof GetRunOptionsWithTaskDetailsSchema>;

const RunSchema = z.object({
  /** The Run id */
  id: z.string(),
  /** The Run status */
  status: RunStatusSchema,
  /** When the run started */
  startedAt: z.coerce.date().nullable(),
  /** When the run was last updated */
  updatedAt: z.coerce.date().nullable(),
  /** When the run was completed */
  completedAt: z.coerce.date().nullable(),
});

export const GetRunSchema = RunSchema.extend({
  /** The output of the run */
  output: z.any().optional(),
  /** The tasks from the run */
  tasks: z.array(RunTaskWithSubtasksSchema),
  /** If there are more tasks, you can use this to get them */
  nextCursor: z.string().optional(),
});

export type GetRun = z.infer<typeof GetRunSchema>;

const GetRunsOptionsSchema = z.object({
  /** You can use this to get more tasks, if there are more than are returned in a single batch @default undefined */
  cursor: z.string().optional(),
  /** How many runs you want to return in one go, max 50. @default 20 */
  take: z.number().optional(),
});

export type GetRunsOptions = z.infer<typeof GetRunsOptionsSchema>;

export const GetRunsSchema = z.object({
  /** The runs from the query */
  runs: RunSchema.array(),
  /** If there are more runs, you can use this to get them */
  nextCursor: z.string().optional(),
});
