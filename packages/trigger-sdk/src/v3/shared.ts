import { SpanKind } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGING_DESTINATION,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import {
  ApiRequestOptions,
  BatchTaskRunExecutionResult,
  FailureFnParams,
  HandleErrorFnParams,
  HandleErrorResult,
  InitFnParams,
  InitOutput,
  MachineCpu,
  MachineMemory,
  MiddlewareFnParams,
  QueueOptions,
  RetryOptions,
  RunFnParams,
  RunTags,
  SemanticInternalAttributes,
  StartFnParams,
  SuccessFnParams,
  TaskRunContext,
  TaskRunExecutionResult,
  accessoryAttributes,
  apiClientManager,
  conditionallyImportPacket,
  createErrorTaskError,
  defaultRetryOptions,
  logger,
  parsePacket,
  runtime,
  stringifyIO,
  taskCatalog,
  taskContext,
} from "@trigger.dev/core/v3";
import { IdempotencyKey, idempotencyKeys, isIdempotencyKey } from "./idempotencyKeys.js";
import { PollOptions, RetrieveRunResult, runs } from "./runs.js";
import { tracer } from "./tracer.js";

export type Context = TaskRunContext;

type RequireOne<T, K extends keyof T> = {
  [X in Exclude<keyof T, K>]?: T[X];
} & {
  [P in K]-?: T[P];
};

export type Queue = RequireOne<QueueOptions, "name">;

export function queue(options: { name: string } & QueueOptions): Queue {
  return options;
}

export type TaskOptions<
  TIdentifier extends string,
  TPayload = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
> = {
  /** An id for your task. This must be unique inside your project and not change between versions.  */
  id: TIdentifier;
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
  queue?: QueueOptions;
  /** Configure the spec of the machine you want your task to run on.
   * 
   * @example
   * 
   * ```ts
   * export const heavyTask = task({
      id: "heavy-task",
      machine: {
        cpu: 2,
        memory: 4,
      },
      run: async ({ payload, ctx }) => {
        //...
      },
    });
   * ```
  */
  machine?: {
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
    preset?:
      | "micro"
      | "small-1x"
      | "small-2x"
      | "medium-1x"
      | "medium-2x"
      | "large-1x"
      | "large-2x";
  };

  /** This gets called when a task is triggered. It's where you put the code you want to execute.
   *
   * @param payload - The payload that is passed to your task when it's triggered. This must be JSON serializable.
   * @param params - Metadata about the run.
   */
  run: (payload: TPayload, params: RunFnParams<TInitOutput>) => Promise<TOutput>;

  /**
   * init is called before the run function is called. It's useful for setting up any global state.
   */
  init?: (payload: TPayload, params: InitFnParams) => Promise<TInitOutput>;

  /**
   * cleanup is called after the run function has completed.
   */
  cleanup?: (payload: TPayload, params: RunFnParams<TInitOutput>) => Promise<void>;

  /**
   * handleError is called when the run function throws an error. It can be used to modify the error or return new retry options.
   */
  handleError?: (
    payload: TPayload,
    error: unknown,
    params: HandleErrorFnParams<TInitOutput>
  ) => HandleErrorResult;

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
  middleware?: (payload: TPayload, params: MiddlewareFnParams) => Promise<void>;

  /**
   * onStart is called the first time a task is executed in a run (not before every retry)
   */
  onStart?: (payload: TPayload, params: StartFnParams) => Promise<void>;

  /**
   * onSuccess is called after the run function has successfully completed.
   */
  onSuccess?: (
    payload: TPayload,
    output: TOutput,
    params: SuccessFnParams<TInitOutput>
  ) => Promise<void>;

  /**
   * onFailure is called after a task run has failed (meaning the run function threw an error and won't be retried anymore)
   */
  onFailure?: (
    payload: TPayload,
    error: unknown,
    params: FailureFnParams<TInitOutput>
  ) => Promise<void>;
};

declare const __output: unique symbol;
type BrandOutput<B> = { [__output]: B };
export type BrandedOutput<T, B> = T & BrandOutput<B>;

export type RunHandle<TOutput> = BrandedOutput<
  {
    id: string;
  },
  TOutput
>;

/**
 * A BatchRunHandle can be used to retrieve the runs of a batch trigger in a typesafe manner.
 */
export type BatchRunHandle<TOutput> = BrandedOutput<
  {
    batchId: string;
    runs: Array<RunHandle<TOutput>>;
  },
  TOutput
>;

export type RunHandleOutput<TRunHandle> = TRunHandle extends RunHandle<infer TOutput>
  ? TOutput
  : never;

export type TaskRunResult<TOutput = any> =
  | {
      ok: true;
      id: string;
      output: TOutput;
    }
  | {
      ok: false;
      id: string;
      error: unknown;
    };

export class SubtaskUnwrapError extends Error {
  constructor(taskId: string, subtaskError: unknown) {
    if (subtaskError instanceof Error) {
      super(`Error in ${taskId}: ${subtaskError.message}`, { cause: subtaskError });
      this.name = "SubtaskUnwrapError";
    } else {
      super(`Error in ${taskId}`, { cause: subtaskError });
      this.name = "SubtaskUnwrapError";
    }
  }
}

export class TaskRunPromise<T> extends Promise<TaskRunResult<T>> {
  constructor(
    executor: (
      resolve: (value: TaskRunResult<T> | PromiseLike<TaskRunResult<T>>) => void,
      reject: (reason?: any) => void
    ) => void,
    private readonly taskId: string
  ) {
    super(executor);
  }

  unwrap(): Promise<T> {
    return this.then((result) => {
      if (result.ok) {
        return result.output;
      } else {
        throw new SubtaskUnwrapError(this.taskId, result.error);
      }
    });
  }
}

export type BatchResult<TOutput = any> = {
  id: string;
  runs: TaskRunResult<TOutput>[];
};

export type BatchItem<TInput> = TInput extends void
  ? { payload?: TInput; options?: TaskRunOptions }
  : { payload: TInput; options?: TaskRunOptions };

export interface Task<TIdentifier extends string, TInput = void, TOutput = any> {
  /**
   * The id of the task.
   */
  id: TIdentifier;
  /**
   * Trigger a task with the given payload, and continue without waiting for the result. If you want to wait for the result, use `triggerAndWait`. Returns the id of the triggered task run.
   * @param payload
   * @param options
   * @returns RunHandle
   * - `id` - The id of the triggered task run.
   */
  trigger: (payload: TInput, options?: TaskRunOptions) => Promise<RunHandle<TOutput>>;

  /**
   * Batch trigger multiple task runs with the given payloads, and continue without waiting for the results. If you want to wait for the results, use `batchTriggerAndWait`. Returns the id of the triggered batch.
   * @param items
   * @returns InvokeBatchHandle
   * - `batchId` - The id of the triggered batch.
   * - `runs` - The ids of the triggered task runs.
   */
  batchTrigger: (items: Array<BatchItem<TInput>>) => Promise<BatchRunHandle<TOutput>>;

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
  triggerAndWait: (payload: TInput, options?: TaskRunOptions) => TaskRunPromise<TOutput>;

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
  batchTriggerAndWait: (items: Array<BatchItem<TInput>>) => Promise<BatchResult<TOutput>>;
}

export type AnyTask = Task<string, any, any>;

export type TaskPayload<TTask extends AnyTask> = TTask extends Task<string, infer TInput, any>
  ? TInput
  : never;

export type TaskOutput<TTask extends AnyTask> = TTask extends Task<string, any, infer TOutput>
  ? TOutput
  : never;

export type TaskOutputHandle<TTask extends AnyTask> = TTask extends Task<string, any, infer TOutput>
  ? RunHandle<TOutput>
  : never;

export type TaskBatchOutputHandle<TTask extends AnyTask> = TTask extends Task<
  string,
  any,
  infer TOutput
>
  ? BatchRunHandle<TOutput>
  : never;

export type TaskIdentifier<TTask extends AnyTask> = TTask extends Task<infer TIdentifier, any, any>
  ? TIdentifier
  : never;

export type TaskRunOptions = {
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
  maxAttempts?: number;
  queue?: TaskRunConcurrencyOptions;
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
   * Tags to attach to the run. Tags can be used to filter runs in the dashboard and using the SDK.
   *
   * You can set up to 5 tags per run, they must be less than 64 characters each.
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
};

type TaskRunConcurrencyOptions = Queue;

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type DynamicBaseOptions = {
  id: string;
};

export function createTask<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>
): Task<TIdentifier, TInput, TOutput> {
  const customQueue = params.queue
    ? queue({
        name: params.queue?.name ?? `task/${params.id}`,
        ...params.queue,
      })
    : undefined;

  const task: Task<TIdentifier, TInput, TOutput> = {
    id: params.id,
    trigger: async (payload, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await trigger_internal<TInput, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.trigger()`
          : `trigger()`,
        params.id,
        payload,
        {
          queue: customQueue,
          ...options,
        }
      );
    },
    batchTrigger: async (items) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTrigger_internal<TInput, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTrigger()`
          : `batchTrigger()`,
        params.id,
        items,
        undefined,
        customQueue
      );
    },
    triggerAndWait: (payload, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return new TaskRunPromise<TOutput>((resolve, reject) => {
        triggerAndWait_internal<TInput, TOutput>(
          taskMetadata && taskMetadata.exportName
            ? `${taskMetadata.exportName}.triggerAndWait()`
            : `triggerAndWait()`,
          params.id,
          payload,
          {
            queue: customQueue,
            ...options,
          }
        )
          .then((result) => {
            resolve(result);
          })
          .catch((error) => {
            reject(error);
          });
      }, params.id);
    },
    batchTriggerAndWait: async (items) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTriggerAndWait_internal<TInput, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTriggerAndWait()`
          : `batchTriggerAndWait()`,
        params.id,
        items,
        undefined,
        customQueue
      );
    },
  };

  taskCatalog.registerTaskMetadata({
    id: params.id,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: params.machine,
    fns: {
      run: params.run,
      init: params.init,
      cleanup: params.cleanup,
      middleware: params.middleware,
      handleError: params.handleError,
      onSuccess: params.onSuccess,
      onFailure: params.onFailure,
      onStart: params.onStart,
    },
  });

  // @ts-expect-error
  task[Symbol.for("trigger.dev/task")] = true;

  return task;
}

/**
 * Trigger a task by its identifier with the given payload. Returns a typesafe `RunHandle`.
 *
 * @example
 *
 * ```ts
 * import { tasks, runs } from "@trigger.dev/sdk/v3";
 * import type { myTask } from "./myTasks"; // Import just the type of the task
 *
 * const handle = await tasks.trigger<typeof myTask>("my-task", { foo: "bar" }); // The id and payload are fully typesafe
 * const run = await runs.retrieve(handle);
 * console.log(run.output) // The output is also fully typed
 * ```
 *
 * @returns {RunHandle} An object with the `id` of the run. Can be used to retrieve the completed run output in a typesafe manner.
 */
export async function trigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  payload: TaskPayload<TTask>,
  options?: TaskRunOptions,
  requestOptions?: ApiRequestOptions
): Promise<RunHandle<TaskOutput<TTask>>> {
  return await trigger_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
    "tasks.trigger()",
    id,
    payload,
    options,
    requestOptions
  );
}

/**
 * Trigger a task with the given payload, and wait for the result. Returns the result of the task run
 * @param id - The id of the task to trigger
 * @param payload
 * @param options - Options for the task run
 * @returns TaskRunResult
 * @example
 * ```ts
 * import { tasks } from "@trigger.dev/sdk/v3";
 * const result = await tasks.triggerAndWait("my-task", { foo: "bar" });
 *
 * if (result.ok) {
 *  console.log(result.output);
 * } else {
 *  console.error(result.error);
 * }
 * ```
 */
export function triggerAndWait<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  payload: TaskPayload<TTask>,
  options?: TaskRunOptions,
  requestOptions?: ApiRequestOptions
): TaskRunPromise<TaskOutput<TTask>> {
  return new TaskRunPromise<TaskOutput<TTask>>((resolve, reject) => {
    triggerAndWait_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
      "tasks.triggerAndWait()",
      id,
      payload,
      options,
      requestOptions
    )
      .then((result) => {
        resolve(result);
      })
      .catch((error) => {
        reject(error);
      });
  }, id);
}

/**
 * Batch trigger multiple task runs with the given payloads, and wait for the results. Returns the results of the task runs.
 * @param id - The id of the task to trigger
 * @param items
 * @returns BatchResult
 * @example
 *
 * ```ts
 * import { tasks } from "@trigger.dev/sdk/v3";
 *
 * const result = await tasks.batchTriggerAndWait("my-task", [
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
export async function batchTriggerAndWait<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  items: Array<BatchItem<TaskPayload<TTask>>>,
  requestOptions?: ApiRequestOptions
): Promise<BatchResult<TaskOutput<TTask>>> {
  return await batchTriggerAndWait_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
    "tasks.batchTriggerAndWait()",
    id,
    items,
    requestOptions
  );
}

/**
 * Trigger a task by its identifier with the given payload and poll until the run is completed.
 *
 * @example
 *
 * ```ts
 * import { tasks, runs } from "@trigger.dev/sdk/v3";
 * import type { myTask } from "./myTasks"; // Import just the type of the task
 *
 * const run = await tasks.triggerAndPoll<typeof myTask>("my-task", { foo: "bar" }); // The id and payload are fully typesafe
 * console.log(run.output) // The output is also fully typed
 * ```
 *
 * @returns {Run} The completed run, either successful or failed.
 */
export async function triggerAndPoll<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  payload: TaskPayload<TTask>,
  options?: TaskRunOptions & PollOptions,
  requestOptions?: ApiRequestOptions
): Promise<RetrieveRunResult<RunHandle<TaskOutput<TTask>>>> {
  const handle = await trigger(id, payload, options, requestOptions);

  return runs.poll(handle, options, requestOptions);
}

export async function batchTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  items: Array<BatchItem<TaskPayload<TTask>>>,
  requestOptions?: ApiRequestOptions
): Promise<BatchRunHandle<TaskOutput<TTask>>> {
  return await batchTrigger_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
    "tasks.batchTrigger()",
    id,
    items,
    requestOptions
  );
}

async function trigger_internal<TPayload, TOutput>(
  name: string,
  id: string,
  payload: TPayload,
  options?: TaskRunOptions,
  requestOptions?: ApiRequestOptions
): Promise<RunHandle<TOutput>> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const payloadPacket = await stringifyIO(payload);

  const handle = await apiClient.triggerTask(
    id,
    {
      payload: payloadPacket.data,
      options: {
        queue: options?.queue,
        concurrencyKey: options?.concurrencyKey,
        test: taskContext.ctx?.run.isTest,
        payloadType: payloadPacket.dataType,
        idempotencyKey: await makeKey(options?.idempotencyKey),
        delay: options?.delay,
        ttl: options?.ttl,
        tags: options?.tags,
        maxAttempts: options?.maxAttempts,
      },
    },
    {
      spanParentAsLink: true,
    },
    {
      name,
      tracer,
      icon: "trigger",
      attributes: {
        [SEMATTRS_MESSAGING_OPERATION]: "publish",
        ["messaging.client_id"]: taskContext.worker?.id,
        [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
        ...accessoryAttributes({
          items: [
            {
              text: id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
      onResponseBody: (body, span) => {
        body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          "id" in body &&
          typeof body.id === "string" &&
          span.setAttribute("messaging.message.id", body.id);
      },
      ...requestOptions,
    }
  );

  return handle as RunHandle<TOutput>;
}

async function batchTrigger_internal<TPayload, TOutput>(
  name: string,
  id: string,
  items: Array<BatchItem<TPayload>>,
  requestOptions?: ApiRequestOptions,
  queue?: QueueOptions
): Promise<BatchRunHandle<TOutput>> {
  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const response = await apiClient.batchTriggerTask(
    id,
    {
      items: await Promise.all(
        items.map(async (item) => {
          const payloadPacket = await stringifyIO(item.payload);

          return {
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue ?? queue,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              idempotencyKey: await makeKey(item.options?.idempotencyKey),
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
            },
          };
        })
      ),
    },
    { spanParentAsLink: true },
    {
      name,
      tracer,
      icon: "trigger",
      attributes: {
        [SEMATTRS_MESSAGING_OPERATION]: "publish",
        ["messaging.client_id"]: taskContext.worker?.id,
        [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
        ...accessoryAttributes({
          items: [
            {
              text: id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.batchId,
    runs: response.runs.map((id) => ({ id })),
  };

  return handle as BatchRunHandle<TOutput>;
}

async function triggerAndWait_internal<TPayload, TOutput>(
  name: string,
  id: string,
  payload: TPayload,
  options?: TaskRunOptions,
  requestOptions?: ApiRequestOptions
): Promise<TaskRunResult<TOutput>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("triggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  const payloadPacket = await stringifyIO(payload);

  return await tracer.startActiveSpan(
    name,
    async (span) => {
      const response = await apiClient.triggerTask(
        id,
        {
          payload: payloadPacket.data,
          options: {
            dependentAttempt: ctx.attempt.id,
            lockToVersion: taskContext.worker?.version, // Lock to current version because we're waiting for it to finish
            queue: options?.queue,
            concurrencyKey: options?.concurrencyKey,
            test: taskContext.ctx?.run.isTest,
            payloadType: payloadPacket.dataType,
            idempotencyKey: await makeKey(options?.idempotencyKey),
            delay: options?.delay,
            ttl: options?.ttl,
            tags: options?.tags,
            maxAttempts: options?.maxAttempts,
          },
        },
        {},
        requestOptions
      );

      span.setAttribute("messaging.message.id", response.id);

      if (options?.idempotencyKey) {
        // If an idempotency key is provided, we can check if the result is already available
        const result = await apiClient.getRunResult(response.id);

        if (result) {
          logger.log(
            `Result reused from previous task run with idempotency key '${options.idempotencyKey}'.`,
            {
              runId: response.id,
              idempotencyKey: options.idempotencyKey,
            }
          );

          return await handleTaskRunExecutionResult<TOutput>(result);
        }
      }

      const result = await runtime.waitForTask({
        id: response.id,
        ctx,
      });

      return await handleTaskRunExecutionResult<TOutput>(result);
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
        [SEMATTRS_MESSAGING_OPERATION]: "publish",
        ["messaging.client_id"]: taskContext.worker?.id,
        [SEMATTRS_MESSAGING_DESTINATION]: id,
        [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
        ...accessoryAttributes({
          items: [
            {
              text: id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    }
  );
}

async function batchTriggerAndWait_internal<TPayload, TOutput>(
  name: string,
  id: string,
  items: Array<BatchItem<TPayload>>,
  requestOptions?: ApiRequestOptions,
  queue?: QueueOptions
): Promise<BatchResult<TOutput>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.client;

  if (!apiClient) {
    throw apiClientMissingError();
  }

  return await tracer.startActiveSpan(
    name,
    async (span) => {
      const response = await apiClient.batchTriggerTask(
        id,
        {
          items: await Promise.all(
            items.map(async (item) => {
              const payloadPacket = await stringifyIO(item.payload);

              return {
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue ?? queue,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  idempotencyKey: await makeKey(item.options?.idempotencyKey),
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                },
              };
            })
          ),
          dependentAttempt: ctx.attempt.id,
        },
        {},
        requestOptions
      );

      span.setAttribute("messaging.message.id", response.batchId);

      const getBatchResults = async (): Promise<BatchTaskRunExecutionResult> => {
        // We need to check if the results are already available, but only if any of the items options has an idempotency key
        const hasIdempotencyKey = items.some((item) => item.options?.idempotencyKey);

        if (hasIdempotencyKey) {
          const results = await apiClient.getBatchResults(response.batchId);

          if (results) {
            return results;
          }
        }

        return {
          id: response.batchId,
          items: [],
        };
      };

      const existingResults = await getBatchResults();

      const incompleteRuns = response.runs.filter(
        (runId) => !existingResults.items.some((item) => item.id === runId)
      );

      if (incompleteRuns.length === 0) {
        logger.log(
          `Results reused from previous task runs because of the provided idempotency keys.`
        );

        // All runs are already completed
        const runs = await handleBatchTaskRunExecutionResult<TOutput>(existingResults.items);

        return {
          id: existingResults.id,
          runs,
        };
      }

      const result = await runtime.waitForBatch({
        id: response.batchId,
        runs: incompleteRuns,
        ctx,
      });

      // Combine the already completed runs with the newly completed runs, ordered by the original order
      const combinedItems: BatchTaskRunExecutionResult["items"] = [];

      for (const runId of response.runs) {
        const existingItem = existingResults.items.find((item) => item.id === runId);

        if (existingItem) {
          combinedItems.push(existingItem);
        } else {
          const newItem = result.items.find((item) => item.id === runId);

          if (newItem) {
            combinedItems.push(newItem);
          }
        }
      }

      const runs = await handleBatchTaskRunExecutionResult<TOutput>(combinedItems);

      return {
        id: result.id,
        runs,
      };
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
        ["messaging.batch.message_count"]: items.length,
        [SEMATTRS_MESSAGING_OPERATION]: "publish",
        ["messaging.client_id"]: taskContext.worker?.id,
        [SEMATTRS_MESSAGING_DESTINATION]: id,
        [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
        ...accessoryAttributes({
          items: [
            {
              text: id,
              variant: "normal",
            },
          ],
          style: "codepath",
        }),
      },
    }
  );
}

async function handleBatchTaskRunExecutionResult<TOutput>(
  items: Array<TaskRunExecutionResult>
): Promise<Array<TaskRunResult<TOutput>>> {
  const someObjectStoreOutputs = items.some(
    (item) => item.ok && item.outputType === "application/store"
  );

  if (!someObjectStoreOutputs) {
    const results = await Promise.all(
      items.map(async (item) => {
        return await handleTaskRunExecutionResult<TOutput>(item);
      })
    );

    return results;
  }

  return await tracer.startActiveSpan(
    "store.downloadPayloads",
    async (span) => {
      const results = await Promise.all(
        items.map(async (item) => {
          return await handleTaskRunExecutionResult<TOutput>(item);
        })
      );

      return results;
    },
    {
      kind: SpanKind.INTERNAL,
      [SemanticInternalAttributes.STYLE_ICON]: "cloud-download",
    }
  );
}

async function handleTaskRunExecutionResult<TOutput>(
  execution: TaskRunExecutionResult
): Promise<TaskRunResult<TOutput>> {
  if (execution.ok) {
    const outputPacket = { data: execution.output, dataType: execution.outputType };
    const importedPacket = await conditionallyImportPacket(outputPacket, tracer);

    return {
      ok: true,
      id: execution.id,
      output: await parsePacket(importedPacket),
    };
  } else {
    return {
      ok: false,
      id: execution.id,
      error: createErrorTaskError(execution.error),
    };
  }
}

export function apiClientMissingError() {
  const hasBaseUrl = !!apiClientManager.baseURL;
  const hasAccessToken = !!apiClientManager.accessToken;
  if (!hasBaseUrl && !hasAccessToken) {
    return `You need to set the TRIGGER_API_URL and TRIGGER_SECRET_KEY environment variables.`;
  } else if (!hasBaseUrl) {
    return `You need to set the TRIGGER_API_URL environment variable.`;
  } else if (!hasAccessToken) {
    return `You need to set the TRIGGER_SECRET_KEY environment variable.`;
  }

  return `Unknown error`;
}

async function makeKey(
  idempotencyKey?: IdempotencyKey | string | string[]
): Promise<IdempotencyKey | undefined> {
  if (!idempotencyKey) {
    return;
  }

  if (isIdempotencyKey(idempotencyKey)) {
    return idempotencyKey;
  }

  return await idempotencyKeys.create(idempotencyKey, { scope: "global" });
}
