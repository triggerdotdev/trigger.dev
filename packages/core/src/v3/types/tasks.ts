import { SerializableJson } from "../../schemas/json.js";
import { TriggerApiRequestOptions } from "../apiClient/index.js";
import {
  AnyOnCatchErrorHookFunction,
  OnCatchErrorHookFunction,
  OnCleanupHookFunction,
  OnCompleteHookFunction,
  OnFailureHookFunction,
  OnInitHookFunction,
  OnMiddlewareHookFunction,
  OnResumeHookFunction,
  OnStartHookFunction,
  OnSuccessHookFunction,
  OnWaitHookFunction,
  OnCancelHookFunction,
} from "../lifecycleHooks/types.js";
import { RunTags } from "../schemas/api.js";
import {
  MachineCpu,
  MachineMemory,
  MachinePresetName,
  RetryOptions,
  TaskMetadata,
  TaskRunContext,
} from "../schemas/index.js";
import { IdempotencyKey } from "./idempotencyKeys.js";
import { QueueOptions } from "./queues.js";
import { AnySchemaParseFn, inferSchemaIn, inferSchemaOut, Schema } from "./schemas.js";
import { inferToolParameters, ToolTaskParameters } from "./tools.js";
import { Prettify } from "./utils.js";

export type Queue = QueueOptions;
export type TaskSchema = Schema;
export type { inferSchemaIn } from "./schemas.js";

export class SubtaskUnwrapError extends Error {
  public readonly taskId: string;
  public readonly runId: string;
  public readonly cause?: unknown;

  constructor(taskId: string, runId: string, subtaskError: unknown) {
    if (subtaskError instanceof Error) {
      super(`Error in ${taskId}: ${subtaskError.message}`);
      this.cause = subtaskError;
      this.name = "SubtaskUnwrapError";
    } else {
      super(`Error in ${taskId}`);
      this.name = "SubtaskUnwrapError";
      this.cause = subtaskError;
    }

    this.taskId = taskId;
    this.runId = runId;
  }
}

export class TaskRunPromise<TIdentifier extends string, TOutput> extends Promise<
  TaskRunResult<TIdentifier, TOutput>
> {
  constructor(
    executor: (
      resolve: (
        value:
          | TaskRunResult<TIdentifier, TOutput>
          | PromiseLike<TaskRunResult<TIdentifier, TOutput>>
      ) => void,
      reject: (reason?: any) => void
    ) => void,
    private readonly taskId: TIdentifier
  ) {
    super(executor);
  }

  unwrap(): Promise<TOutput> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw new SubtaskUnwrapError(this.taskId, result.id, result.error);
      }
    });
  }
}

export type InitOutput = Record<string, any> | void | undefined;

export type RunFnParams<TInitOutput extends InitOutput> = Prettify<{
  /** Metadata about the task, run, attempt, queue, environment, organization, project and batch.  */
  ctx: Context;
  /** If you use the `init` function, this will be whatever you returned. */
  init?: TInitOutput;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration or if the task run is cancelled. Can be used to automatically cancel downstream requests */
  signal: AbortSignal;
}>;

export type MiddlewareFnParams = Prettify<{
  ctx: Context;
  next: () => Promise<void>;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration or if the task run is cancelled. Can be used to automatically cancel downstream requests */
  signal: AbortSignal;
}>;

export type InitFnParams = Prettify<{
  ctx: Context;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration or if the task run is cancelled. Can be used to automatically cancel downstream requests */
  signal: AbortSignal;
}>;

export type StartFnParams = Prettify<{
  ctx: Context;
  init?: InitOutput;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration or if the task run is cancelled. Can be used to automatically cancel downstream requests */
  signal: AbortSignal;
}>;

export type CancelFnParams = Prettify<{
  ctx: Context;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration or if the task run is cancelled. Can be used to automatically cancel downstream requests */
  signal: AbortSignal;
  runPromise: Promise<unknown>;
  init?: InitOutput;
}>;

export type Context = TaskRunContext;

export type SuccessFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput>;

export type FailureFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput>;

export type HandleErrorFnParams<TInitOutput extends InitOutput> = RunFnParams<TInitOutput> &
  Prettify<{
    retry?: RetryOptions;
    retryAt?: Date;
    retryDelayInMs?: number;
  }>;

export type HandleErrorModificationOptions = {
  skipRetrying?: boolean | undefined;
  retryAt?: Date | undefined;
  retryDelayInMs?: number | undefined;
  retry?: RetryOptions | undefined;
  error?: unknown;
};

export type HandleErrorResult =
  | undefined
  | void
  | HandleErrorModificationOptions
  | Promise<undefined | void | HandleErrorModificationOptions>;

export type HandleErrorArgs = {
  ctx: Context;
  init?: Record<string, unknown>;
  retry?: RetryOptions;
  retryAt?: Date;
  retryDelayInMs?: number;
  /** Abort signal that is aborted when a task run exceeds it's maxDuration. Can be used to automatically cancel downstream requests */
  signal?: AbortSignal;
};

export type HandleErrorFunction = AnyOnCatchErrorHookFunction;

type CommonTaskOptions<
  TIdentifier extends string,
  TPayload = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
> = {
  /** An id for your task. This must be unique inside your project and not change between versions.  */
  id: TIdentifier;

  description?: string;

  /** The retry settings when an uncaught error is thrown.
       *
       * If omitted it will use the values in your `trigger.config.ts` file.
       *
       * @example
       *
       * ```
       * export const taskWithRetries = task({
          id: "task-with-retries",
          retry: {
            maxAttempts: 10,
            factor: 1.8,
            minTimeoutInMs: 500,
            maxTimeoutInMs: 30_000,
            randomize: false,
          },
          run: async ({ payload, ctx }) => {
            //...
          },
        });
      * ```
      * */
  retry?: RetryOptions;

  /** Used to configure what should happen when more than one run is triggered at the same time.
   *
   * @example
   * one at a time execution
   *
   * ```ts
   * export const oneAtATime = task({
      id: "one-at-a-time",
      queue: {
        concurrencyLimit: 1,
      },
      run: async ({ payload, ctx }) => {
        //...
      },
    });
   * ```
   */
  queue?: {
    name?: string;
    concurrencyLimit?: number;
    releaseConcurrencyOnWaitpoint?: boolean;
  };
  /** Configure the spec of the [machine](https://trigger.dev/docs/machines) you want your task to run on.
   *
   * @example
   *
   * ```ts
   * export const heavyTask = task({
      id: "heavy-task",
      machine: "medium-1x",
      run: async ({ payload, ctx }) => {
        //...
      },
    });
   * ```
  */
  machine?:
    | {
        /** vCPUs. The default is 0.5.
         *
         * Possible values:
         * - 0.25
         * - 0.5
         * - 1
         * - 2
         * - 4
         * @deprecated use preset instead
         */
        cpu?: MachineCpu;
        /** In GBs of RAM. The default is 1.
         *
         * Possible values:
         * - 0.25
         * - 0.5
         * - 1
         * - 2
         * - 4
         * - 8
         * * @deprecated use preset instead
         */
        memory?: MachineMemory;

        /** Preset to use for the machine. Defaults to small-1x */
        preset?: MachinePresetName;
      }
    | MachinePresetName;

  /**
   * The maximum duration in compute-time seconds that a task run is allowed to run. If the task run exceeds this duration, it will be stopped.
   *
   * Minimum value is 5 seconds
   */
  maxDuration?: number;

  /** This gets called when a task is triggered. It's where you put the code you want to execute.
   *
   * @param payload - The payload that is passed to your task when it's triggered. This must be JSON serializable.
   * @param params - Metadata about the run.
   */
  run: (payload: TPayload, params: RunFnParams<TInitOutput>) => Promise<TOutput>;

  /**
   * init is called before the run function is called. It's useful for setting up any global state.
   *
   * @deprecated Use locals and middleware instead
   */
  init?: OnInitHookFunction<TPayload, TInitOutput>;

  /**
   * cleanup is called after the run function has completed.
   *
   * @deprecated Use middleware instead
   */
  cleanup?: OnCleanupHookFunction<TPayload, TInitOutput>;

  /**
   * handleError is called when the run function throws an error. It can be used to modify the error or return new retry options.
   *
   * @deprecated Use catchError instead
   */
  handleError?: OnCatchErrorHookFunction<TPayload>;

  /**
   * catchError is called when the run function throws an error. It can be used to modify the error or return new retry options.
   */
  catchError?: OnCatchErrorHookFunction<TPayload>;

  onResume?: OnResumeHookFunction<TPayload>;
  onWait?: OnWaitHookFunction<TPayload>;
  onComplete?: OnCompleteHookFunction<TPayload, TOutput>;
  onCancel?: OnCancelHookFunction<TPayload, TOutput, TInitOutput>;

  /**
   * middleware allows you to run code "around" the run function. This can be useful for logging, metrics, or other cross-cutting concerns.
   *
   * When writing middleware, you should always call `next()` to continue the execution of the task:
   *
   * ```ts
   * export const middlewareTask = task({
   *  id: "middleware-task",
   *  middleware: async (payload, { ctx, next }) => {
   *   console.log("Before run");
   *   await next();
   *   console.log("After run");
   *  },
   *  run: async (payload, { ctx }) => {}
   * });
   * ```
   */
  middleware?: OnMiddlewareHookFunction<TPayload>;

  /**
   * onStart is called the first time a task is executed in a run (not before every retry)
   */
  onStart?: OnStartHookFunction<TPayload, TInitOutput>;

  /**
   * onSuccess is called after the run function has successfully completed.
   */
  onSuccess?: OnSuccessHookFunction<TPayload, TOutput, TInitOutput>;

  /**
   * onFailure is called after a task run has failed (meaning the run function threw an error and won't be retried anymore)
   */
  onFailure?: OnFailureHookFunction<TPayload, TInitOutput>;
};

export type TaskOptions<
  TIdentifier extends string,
  TPayload = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
> = CommonTaskOptions<TIdentifier, TPayload, TOutput, TInitOutput>;

export type TaskWithSchemaOptions<
  TIdentifier extends string,
  TSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
> = CommonTaskOptions<TIdentifier, inferSchemaOut<TSchema>, TOutput, TInitOutput> & {
  schema?: TSchema;
};

export type TaskWithToolOptions<
  TIdentifier extends string,
  TParameters extends ToolTaskParameters,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
> = CommonTaskOptions<TIdentifier, inferToolParameters<TParameters>, TOutput, TInitOutput> & {
  parameters: TParameters;
};

declare const __output: unique symbol;
declare const __payload: unique symbol;
type BrandRun<P, O> = { [__output]: O; [__payload]: P };
export type BrandedRun<T, P, O> = T & BrandRun<O, P>;

export type RunHandle<TTaskIdentifier extends string, TPayload, TOutput> = BrandedRun<
  {
    id: string;
    /**
     * An auto-generated JWT that can be used to access the run
     */
    publicAccessToken: string;
    taskIdentifier: TTaskIdentifier;
  },
  TPayload,
  TOutput
>;

export type AnyRunHandle = RunHandle<string, any, any>;

export type BatchedRunHandle<TTaskIdentifier extends string, TPayload, TOutput> = BrandedRun<
  {
    id: string;
    taskIdentifier: TTaskIdentifier;
    isCached: boolean;
    idempotencyKey?: string;
  },
  TPayload,
  TOutput
>;

export type AnyBatchedRunHandle = BatchedRunHandle<string, any, any>;

/**
 * A BatchRunHandle can be used to retrieve the runs of a batch trigger in a typesafe manner.
 */
export type BatchRunHandle<TTaskIdentifier extends string, TPayload, TOutput> = BrandedRun<
  {
    batchId: string;
    runCount: number;
    publicAccessToken: string;
  },
  TOutput,
  TPayload
>;

export type RunHandleOutput<TRunHandle> = TRunHandle extends RunHandle<string, any, infer TOutput>
  ? TOutput
  : never;

export type RunHandlePayload<TRunHandle> = TRunHandle extends RunHandle<string, infer TPayload, any>
  ? TPayload
  : never;

export type RunHandleTaskIdentifier<TRunHandle> = TRunHandle extends RunHandle<
  infer TTaskIdentifier,
  any,
  any
>
  ? TTaskIdentifier
  : never;

export type TaskRunResult<TIdentifier extends string, TOutput = any> =
  | {
      ok: true;
      id: string;
      taskIdentifier: TIdentifier;
      output: TOutput;
    }
  | {
      ok: false;
      id: string;
      taskIdentifier: TIdentifier;
      error: unknown;
    };

export type AnyTaskRunResult = TaskRunResult<string, any>;

export type TaskRunResultFromTask<TTask extends AnyTask> = TTask extends Task<
  infer TIdentifier,
  any,
  infer TOutput
>
  ? TaskRunResult<TIdentifier, TOutput>
  : never;

export type BatchResult<TIdentifier extends string, TOutput = any> = {
  id: string;
  runs: TaskRunResult<TIdentifier, TOutput>[];
};

export type BatchByIdResult<TTask extends AnyTask> = {
  id: string;
  runs: Array<TaskRunResultFromTask<TTask>>;
};

export type BatchByTaskResult<TTasks extends readonly AnyTask[]> = {
  id: string;
  runs: {
    [K in keyof TTasks]: TaskRunResultFromTask<TTasks[K]>;
  };
};

/**
 * A BatchRunHandle can be used to retrieve the runs of a batch trigger in a typesafe manner.
 */
// export type BatchTasksRunHandle<TTasks extends readonly AnyTask[]> = BrandedRun<
//   {
//     batchId: string;
//     isCached: boolean;
//     idempotencyKey?: string;
//     runs: {
//       [K in keyof TTasks]: BatchedRunHandle<
//         TaskIdentifier<TTasks[K]>,
//         TaskPayload<TTasks[K]>,
//         TaskOutput<TTasks[K]>
//       >;
//     };
//     publicAccessToken: string;
//   },
//   any,
//   any
// >;

export type BatchTasksResult<TTasks extends readonly AnyTask[]> = BatchTasksRunHandle<TTasks>;

export type BatchItem<TInput> = { payload: TInput; options?: TriggerOptions };

export type BatchTriggerAndWaitItem<TInput> = {
  payload: TInput;
  options?: TriggerAndWaitOptions;
};

export type BatchByIdItem<TRunTypes extends AnyRunTypes> = {
  id: TRunTypes["taskIdentifier"];
  payload: TRunTypes["payload"];
  options?: TriggerOptions;
};

export type BatchByIdAndWaitItem<TRunTypes extends AnyRunTypes> = {
  id: TRunTypes["taskIdentifier"];
  payload: TRunTypes["payload"];
  options?: TriggerAndWaitOptions;
};

export type BatchByTaskItem<TTask extends AnyTask> = {
  task: TTask;
  payload: TaskPayload<TTask>;
  options?: TriggerOptions;
};

export type BatchByTaskAndWaitItem<TTask extends AnyTask> = {
  task: TTask;
  payload: TaskPayload<TTask>;
  options?: TriggerAndWaitOptions;
};

export interface Task<TIdentifier extends string, TInput = void, TOutput = any> {
  /**
   * The id of the task.
   */
  id: TIdentifier;

  description?: string;

  /**
   * Trigger a task with the given payload, and continue without waiting for the result. If you want to wait for the result, use `triggerAndWait`. Returns the id of the triggered task run.
   * @param payload
   * @param options
   * @returns RunHandle
   * - `id` - The id of the triggered task run.
   */
  trigger: (
    payload: TInput,
    options?: TriggerOptions,
    requestOptions?: TriggerApiRequestOptions
  ) => Promise<RunHandle<TIdentifier, TInput, TOutput>>;

  /**
   * Batch trigger multiple task runs with the given payloads, and continue without waiting for the results. If you want to wait for the results, use `batchTriggerAndWait`. Returns the id of the triggered batch.
   * @param items
   * @returns InvokeBatchHandle
   * - `batchId` - The id of the triggered batch.
   * - `runs` - The ids of the triggered task runs.
   */
  batchTrigger: (
    items: Array<BatchItem<TInput>>,
    options?: BatchTriggerOptions,
    requestOptions?: TriggerApiRequestOptions
  ) => Promise<BatchRunHandle<TIdentifier, TInput, TOutput>>;

  /**
   * Trigger a task with the given payload, and wait for the result. Returns the result of the task run
   * @param payload
   * @param options - Options for the task run
   * @returns TaskRunResult
   * @example
   * ```
   * const result = await task.triggerAndWait({ foo: "bar" });
   *
   * if (result.ok) {
   *  console.log(result.output);
   * } else {
   *  console.error(result.error);
   * }
   * ```
   */
  triggerAndWait: (
    payload: TInput,
    options?: TriggerAndWaitOptions
  ) => TaskRunPromise<TIdentifier, TOutput>;

  /**
   * Batch trigger multiple task runs with the given payloads, and wait for the results. Returns the results of the task runs.
   * @param items
   * @returns BatchResult
   * @example
   * ```
   * const result = await task.batchTriggerAndWait([
   *  { payload: { foo: "bar" } },
   *  { payload: { foo: "baz" } },
   * ]);
   *
   * for (const run of result.runs) {
   *  if (run.ok) {
   *    console.log(run.output);
   *  } else {
   *    console.error(run.error);
   *  }
   * }
   * ```
   */
  batchTriggerAndWait: (
    items: Array<BatchTriggerAndWaitItem<TInput>>,
    options?: BatchTriggerAndWaitOptions
  ) => Promise<BatchResult<TIdentifier, TOutput>>;
}

export interface TaskWithSchema<
  TIdentifier extends string,
  TSchema extends TaskSchema | undefined = undefined,
  TOutput = any,
> extends Task<TIdentifier, inferSchemaIn<TSchema>, TOutput> {
  schema?: TSchema;
}

export interface ToolTask<
  TIdentifier extends string,
  TParameters extends ToolTaskParameters,
  TOutput = any,
> extends Task<TIdentifier, inferToolParameters<TParameters>, TOutput> {
  tool: {
    parameters: TParameters;
    description?: string;
    execute: (args: inferToolParameters<TParameters>) => Promise<TOutput>;
  };
}

export type AnyTask = Task<string, any, any>;

export type TaskPayload<TTask extends AnyTask> = TTask extends Task<string, infer TInput, any>
  ? TInput
  : never;

export type TaskOutput<TTask extends AnyTask> = TTask extends Task<string, any, infer TOutput>
  ? TOutput
  : never;

export type TaskOutputHandle<TTask extends AnyTask> = TTask extends Task<
  infer TIdentifier,
  infer TInput,
  infer TOutput
>
  ? RunHandle<TIdentifier, TOutput, TInput>
  : never;

export type TaskBatchOutputHandle<TTask extends AnyTask> = TTask extends Task<
  infer TIdentifier,
  infer TInput,
  infer TOutput
>
  ? BatchRunHandle<TIdentifier, TOutput, TInput>
  : never;

export type TaskIdentifier<TTask extends AnyTask> = TTask extends Task<infer TIdentifier, any, any>
  ? TIdentifier
  : never;

export type TaskFromIdentifier<
  TTask extends AnyTask,
  TIdentifier extends TTask["id"],
> = TTask extends { id: TIdentifier } ? TTask : never;

export type TriggerJwtOptions = {
  /**
   * The expiration time of the JWT. This can be a string like "1h" or a Date object.
   *
   * Defaults to 1 hour.
   */
  expirationTime?: number | Date | string;
};

export type TriggerOptions = {
  /**
   * A unique key that can be used to ensure that a task is only triggered once per key.
   *
   * You can use `idempotencyKeys.create` to create an idempotency key first, and then pass it to the task options.
   *
   * @example
   *
   * ```typescript
   * import { idempotencyKeys, task } from "@trigger.dev/sdk/v3";
   *
   * export const myTask = task({
   *  id: "my-task",
   *  run: async (payload: any) => {
   *   // scoped to the task run by default
   *   const idempotencyKey = await idempotencyKeys.create("my-task-key");
   *
   *   // Use the idempotency key when triggering child tasks
   *   await childTask.triggerAndWait(payload, { idempotencyKey });
   *
   *   // scoped globally, does not include the task run ID
   *   const globalIdempotencyKey = await idempotencyKeys.create("my-task-key", { scope: "global" });
   *
   *   await childTask.triggerAndWait(payload, { idempotencyKey: globalIdempotencyKey });
   *
   *   // You can also pass a string directly, which is the same as a global idempotency key
   *   await childTask.triggerAndWait(payload, { idempotencyKey: "my-very-unique-key" });
   *  }
   * });
   * ```
   *
   * When triggering a task inside another task, we automatically inject the run ID into the key material.
   *
   * If you are triggering a task from your backend, ensure you include some sufficiently unique key material to prevent collisions.
   *
   * @example
   *
   * ```typescript
   * import { idempotencyKeys, tasks } from "@trigger.dev/sdk/v3";
   *
   * // Somewhere in your backend
   * const idempotencyKey = await idempotenceKeys.create(["my-task-trigger", "user-123"]);
   * await tasks.trigger("my-task", { foo: "bar" }, { idempotencyKey });
   * ```
   *
   */
  idempotencyKey?: IdempotencyKey | string | string[];

  /**
   * The time-to-live for the idempotency key. Once the TTL has passed, the key can be used again.
   *
   * Specify a duration string like "1h", "10s", "30m", etc.
   */
  idempotencyKeyTTL?: string;

  /**
   * The maximum number of retry attempts for the task if it fails.
   * If not specified, it will use the task or the default retry policy from your trigger.config file.
   */
  maxAttempts?: number;

  /**
   * You can override the queue for the task. If a queue doesn't exist for the given name, the run will be in the PENDING_VERSION state until the queue is created..
   */
  queue?: string;

  /**
   * The `concurrencyKey` creates a copy of the queue for every unique value of the key.
   * For example, if the queue (set when triggering or on the task) has a concurrency limit of 10,
   * and you set the concurrency key to `userId`, then each user will have their own queue with a concurrency limit of 10.
   */
  concurrencyKey?: string;

  /**
   * The delay before the task is executed. This can be a string like "1h" or a Date object.
   *
   * @example
   * "1h" - 1 hour
   * "30d" - 30 days
   * "15m" - 15 minutes
   * "2w" - 2 weeks
   * "60s" - 60 seconds
   * new Date("2025-01-01T00:00:00Z")
   */
  delay?: string | Date;

  /**
   * Set a time-to-live for this run. If the run is not executed within this time, it will be removed from the queue and never execute.
   *
   * @example
   *
   * ```ts
   * await myTask.trigger({ foo: "bar" }, { ttl: "1h" });
   * await myTask.trigger({ foo: "bar" }, { ttl: 60 * 60 }); // 1 hour
   * ```
   *
   * The minimum value is 1 second. Setting the `ttl` to `0` will disable the TTL and the run will never expire.
   *
   * **Note:** Runs in development have a default `ttl` of 10 minutes. You can override this by setting the `ttl` option.
   */
  ttl?: string | number;

  /**
   * If triggered at the same time, a higher priority run will be executed first.
   *
   The value is a time offset in seconds that determines the order of dequeuing.
   * If you trigger two runs 9 seconds apart but the second one has `priority: 10`, it will be executed before the first one.
   *
   * @example
   * ```ts
   // no priority = 0
   await myTask.trigger({ foo: "bar" });

   //... imagine 9s pass by

   // this run will start before the run above that was triggered 9s ago (with no priority)
   await myTask.trigger({ foo: "bar" }, { priority: 10 });
   ```
   *
   */
  priority?: number;

  /**
   * Tags to attach to the run. Tags can be used to filter runs in the dashboard and using the SDK.
   *
   * You can set up to 10 tags per run, they must be less than 128 characters each.
   *
   * We recommend prefixing tags with a namespace using an underscore or colon, like `user_1234567` or `org:9876543`.
   *
   * @example
   *
   * ```ts
   * await myTask.trigger({ foo: "bar" }, { tags: ["user:1234567", "org:9876543"] });
   * ```
   */
  tags?: RunTags;

  /**
   * Metadata to attach to the run. Metadata can be used to store additional information about the run. Limited to 256KB.
   */
  metadata?: Record<string, SerializableJson>;

  /**
   * The maximum duration in compute-time seconds that a task run is allowed to run. If the task run exceeds this duration, it will be stopped.
   *
   * This will override the task's maxDuration.
   *
   * Minimum value is 5 seconds
   */
  maxDuration?: number;

  /**
   * The machine preset to use for this run. This will override the task's machine preset and any defaults.
   */
  machine?: MachinePresetName;

  /**
   * Specify the version of the deployed task to run. By default the "current" version is used at the time of execution,
   * but you can specify a specific version to run here. You can also set the TRIGGER_VERSION environment
   * variables to run a specific version for all tasks.
   *
   * @example
   *
   * ```ts
   * await myTask.trigger({ foo: "bar" }, { version: "20250208.1" });
   * ```
   *
   * Note that this option is only available for `trigger` and NOT `triggerAndWait` (and their batch counterparts). The "wait" versions will always be locked
   * to the same version as the parent task that is triggering the child tasks.
   */
  version?: string;
};

export type TriggerAndWaitOptions = Omit<TriggerOptions, "version"> & {
  /**
   * If set to true, this will cause the waitpoint to release the current run from the queue's concurrency.
   *
   * This is useful if you want to allow other runs to execute while the child task is executing
   *
   * @default false
   */
  releaseConcurrency?: boolean;
};
export type BatchTriggerOptions = {
  /**
   * If no idempotencyKey is set on an individual item in the batch, it will use this key on each item + the array index.
   * This is useful to prevent work being done again if the task has to retry.
   */
  idempotencyKey?: IdempotencyKey | string | string[];
  idempotencyKeyTTL?: string;

  /**
   * When true, triggers tasks sequentially in batch order. This ensures ordering but may be slower,
   * especially for large batches.
   *
   * When false (default), triggers tasks in parallel for better performance, but order is not guaranteed.
   *
   * Note: This only affects the order of run creation, not the actual task execution.
   *
   * @default false
   */
  triggerSequentially?: boolean;
};

export type BatchTriggerAndWaitOptions = BatchTriggerOptions;

export type TaskMetadataWithFunctions = TaskMetadata & {
  fns: {
    run: (payload: any, params: RunFnParams<any>) => Promise<any>;
    init?: (payload: any, params: InitFnParams) => Promise<InitOutput>;
    cleanup?: (payload: any, params: RunFnParams<any>) => Promise<void>;
    middleware?: (payload: any, params: MiddlewareFnParams) => Promise<void>;
    handleError?: (
      payload: any,
      error: unknown,
      params: HandleErrorFnParams<any>
    ) => HandleErrorResult;
    onSuccess?: (payload: any, output: any, params: SuccessFnParams<any>) => Promise<void>;
    onFailure?: (payload: any, error: unknown, params: FailureFnParams<any>) => Promise<void>;
    onStart?: (payload: any, params: StartFnParams) => Promise<void>;
    parsePayload?: AnySchemaParseFn;
  };
};

export type RunTypes<TTaskIdentifier extends string, TPayload, TOutput> = {
  output: TOutput;
  payload: TPayload;
  taskIdentifier: TTaskIdentifier;
};

export type AnyRunTypes = RunTypes<string, any, any>;

export type InferRunTypes<T> = T extends RunHandle<
  infer TTaskIdentifier,
  infer TPayload,
  infer TOutput
>
  ? RunTypes<TTaskIdentifier, TPayload, TOutput>
  : T extends BatchedRunHandle<infer TTaskIdentifier, infer TPayload, infer TOutput>
  ? RunTypes<TTaskIdentifier, TPayload, TOutput>
  : T extends Task<infer TTaskIdentifier, infer TPayload, infer TOutput>
  ? RunTypes<TTaskIdentifier, TPayload, TOutput>
  : AnyRunTypes;

export type RunHandleFromTypes<TRunTypes extends AnyRunTypes> = RunHandle<
  TRunTypes["taskIdentifier"],
  TRunTypes["payload"],
  TRunTypes["output"]
>;

export type BatchRunHandleFromTypes<TRunTypes extends AnyRunTypes> = TRunTypes extends AnyRunTypes
  ? BatchRunHandle<TRunTypes["taskIdentifier"], TRunTypes["payload"], TRunTypes["output"]>
  : never;

/**
 * A BatchRunHandle can be used to retrieve the runs of a batch trigger in a typesafe manner.
 */
export type BatchTasksRunHandle<TTasks extends readonly AnyTask[]> = BrandedRun<
  {
    batchId: string;
    isCached: boolean;
    idempotencyKey?: string;
    runs: {
      [K in keyof TTasks]: BatchedRunHandle<
        TaskIdentifier<TTasks[K]>,
        TaskPayload<TTasks[K]>,
        TaskOutput<TTasks[K]>
      >;
    };
    publicAccessToken: string;
  },
  any,
  any
>;

export type BatchTasksRunHandleFromTypes<TTasks extends readonly AnyTask[]> =
  BatchTasksRunHandle<TTasks>;
