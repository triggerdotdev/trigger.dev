import { z } from "zod";
import { Prettify } from "../types.js";
import { RuntimeEnvironmentType } from "./api.js";
import { ErrorWithStack } from "./errors.js";
import { JobRunStatusRecord, JobRunStatusRecordSchema } from "./statuses.js";
import { TaskStatusSchema } from "./tasks.js";

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
  z.literal("UNRESOLVED_AUTH"),
  z.literal("INVALID_PAYLOAD"),
  z.literal("EXECUTING"),
  z.literal("WAITING_TO_CONTINUE"),
  z.literal("WAITING_TO_EXECUTE"),
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
  /** Any status updates that were published from the run */
  statuses: z.array(JobRunStatusRecordSchema).default([]),
  /** If there are more tasks, you can use this to get them */
  nextCursor: z.string().optional(),
});

export type GetRun = Prettify<z.infer<typeof GetRunSchema>>;

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

export type RunNotificationJobMetadata = { id: string; version: string };
export type RunNotificationEnvMetadata = {
  slug: string;
  id: string;
  type: RuntimeEnvironmentType;
};
export type RunNotificationOrgMetadata = { slug: string; id: string; title: string };
export type RunNotificationProjectMetadata = { slug: string; id: string; name: string };
export type RunNotificationAccountMetadata = { id: string; metadata?: any };
export type RunNotificationInvocationMetadata<T = any> = {
  id: string;
  context: any;
  timestamp: Date;
  payload: T;
};
export type RunNotificationRunMetadata = {
  /** The Run id */
  id: string;
  /** The Run status */
  statuses: JobRunStatusRecord[];
  /** When the run started */
  startedAt: Date;
  /** When the run was last updated */
  updatedAt: Date;
  /** When the run was completed */
  completedAt: Date;
  /** If the run was a test or not */
  isTest: boolean;

  executionDurationInMs: number;
  executionCount: number;
};

type RunNotificationCommon<TPayload = any> = {
  /** The Run id */
  id: string;
  /** The Run status */
  statuses: JobRunStatusRecord[];
  /** When the run started */
  startedAt: Date;
  /** When the run was last updated */
  updatedAt: Date;
  /** When the run was completed */
  completedAt: Date;
  /** If the run was a test or not */
  isTest: boolean;

  executionDurationInMs: number;
  executionCount: number;

  /** Job metadata */
  job: RunNotificationJobMetadata;
  /** Environment metadata */
  environment: RunNotificationEnvMetadata;
  /** Organization metadata */
  organization: RunNotificationOrgMetadata;
  /** Project metadata */
  project: RunNotificationProjectMetadata;
  /** Account metadata */
  account?: RunNotificationAccountMetadata;
  /** Invocation metadata */
  invocation: RunNotificationInvocationMetadata<TPayload>;
};

export type SuccessfulRunNotification<TOutput, TPayload = any> = RunNotificationCommon<TPayload> & {
  ok: true;
  /** The Run status */
  status: "SUCCESS";
  /** The output of the run */
  output: TOutput;
};

export type FailedRunNotification<TPayload = any> = RunNotificationCommon<TPayload> & {
  ok: false;
  /** The Run status */
  status: "FAILURE" | "TIMED_OUT" | "ABORTED" | "CANCELED" | "UNRESOLVED_AUTH" | "INVALID_PAYLOAD";
  /** The error of the run */
  error: any;
  /** The task that failed */
  task?: {
    id: string;
    cacheKey: string | null;
    status: string;
    name: string;
    icon: string | null;
    startedAt: string;
    error: ErrorWithStack;
    params: any | null;
  };
};

export type RunNotification<TOutput, TPayload = any> =
  | SuccessfulRunNotification<TOutput, TPayload>
  | FailedRunNotification<TPayload>;
