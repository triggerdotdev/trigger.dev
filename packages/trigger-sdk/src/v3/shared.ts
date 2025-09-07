import { SpanKind } from "@opentelemetry/api";
import { SerializableJson } from "@trigger.dev/core";
import {
  accessoryAttributes,
  apiClientManager,
  ApiRequestOptions,
  conditionallyImportPacket,
  convertToolParametersToSchema,
  createErrorTaskError,
  defaultRetryOptions,
  flattenIdempotencyKey,
  getEnvVar,
  getSchemaParseFn,
  InitOutput,
  lifecycleHooks,
  makeIdempotencyKey,
  parsePacket,
  Queue,
  QueueOptions,
  resourceCatalog,
  runtime,
  SemanticInternalAttributes,
  stringifyIO,
  SubtaskUnwrapError,
  taskContext,
  TaskFromIdentifier,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunPromise,
} from "@trigger.dev/core/v3";
import { PollOptions, runs } from "./runs.js";
import { tracer } from "./tracer.js";

import type {
  AnyOnCatchErrorHookFunction,
  AnyOnCleanupHookFunction,
  AnyOnCompleteHookFunction,
  AnyOnFailureHookFunction,
  AnyOnInitHookFunction,
  AnyOnMiddlewareHookFunction,
  AnyOnResumeHookFunction,
  AnyOnStartHookFunction,
  AnyOnSuccessHookFunction,
  AnyOnWaitHookFunction,
  AnyOnCancelHookFunction,
  AnyRunHandle,
  AnyRunTypes,
  AnyTask,
  AnyTaskRunResult,
  BatchByIdAndWaitItem,
  BatchByIdItem,
  BatchByIdResult,
  BatchByTaskAndWaitItem,
  BatchByTaskItem,
  BatchByTaskResult,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  BatchRunHandleFromTypes,
  BatchTasksRunHandleFromTypes,
  BatchTriggerAndWaitItem,
  BatchTriggerAndWaitOptions,
  BatchTriggerOptions,
  BatchTriggerTaskV2RequestBody,
  InferRunTypes,
  inferSchemaIn,
  inferToolParameters,
  RetrieveRunResult,
  RunHandle,
  RunHandleFromTypes,
  RunHandleOutput,
  RunHandlePayload,
  RunTypes,
  SchemaParseFn,
  Task,
  TaskBatchOutputHandle,
  TaskIdentifier,
  TaskOptions,
  TaskOptionsWithSchema,
  TaskOutput,
  TaskOutputHandle,
  TaskPayload,
  TaskRunResult,
  TaskSchema,
  TaskWithSchema,
  TaskWithSchemaOptions,
  TaskWithToolOptions,
  ToolTask,
  ToolTaskParameters,
  TriggerAndWaitOptions,
  TriggerApiRequestOptions,
  TriggerOptions,
} from "@trigger.dev/core/v3";

export type {
  AnyRunHandle,
  AnyTask,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  BatchTriggerOptions,
  Queue,
  RunHandle,
  RunHandleOutput,
  RunHandlePayload,
  SerializableJson,
  Task,
  TaskBatchOutputHandle,
  TaskFromIdentifier,
  TaskIdentifier,
  TaskOptions,
  TaskOutput,
  TaskOutputHandle,
  TaskPayload,
  TaskRunResult,
  TriggerOptions,
};

export { SubtaskUnwrapError, TaskRunPromise };

export type Context = TaskRunContext;

export function queue(options: QueueOptions): Queue {
  resourceCatalog.registerQueueMetadata(options);

  // @ts-expect-error
  options[Symbol.for("trigger.dev/queue")] = true;

  return options;
}

// Overload: when payloadSchema is provided, payload type should be any
export function createTask<
  TIdentifier extends string,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskOptionsWithSchema<TIdentifier, TOutput, TInitOutput>
): Task<TIdentifier, any, TOutput>;

// Overload: normal case without payloadSchema
export function createTask<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>
): Task<TIdentifier, TInput, TOutput>;

export function createTask<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params:
    | TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>
    | TaskOptionsWithSchema<TIdentifier, TOutput, TInitOutput>
): Task<TIdentifier, TInput, TOutput> | Task<TIdentifier, any, TOutput> {
  const task: Task<TIdentifier, TInput, TOutput> = {
    id: params.id,
    description: params.description,
    jsonSchema: params.jsonSchema,
    trigger: async (payload, options) => {
      return await trigger_internal<RunTypes<TIdentifier, TInput, TOutput>>(
        "trigger()",
        params.id,
        payload,
        undefined,
        {
          queue: params.queue?.name,
          ...options,
        }
      );
    },
    batchTrigger: async (items, options) => {
      return await batchTrigger_internal<RunTypes<TIdentifier, TInput, TOutput>>(
        "batchTrigger()",
        params.id,
        items,
        options,
        undefined,
        undefined,
        params.queue?.name
      );
    },
    triggerAndWait: (payload, options) => {
      return new TaskRunPromise<TIdentifier, TOutput>((resolve, reject) => {
        triggerAndWait_internal<TIdentifier, TInput, TOutput>(
          "triggerAndWait()",
          params.id,
          payload,
          undefined,
          {
            queue: params.queue?.name,
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
    batchTriggerAndWait: async (items, options) => {
      return await batchTriggerAndWait_internal<TIdentifier, TInput, TOutput>(
        "batchTriggerAndWait()",
        params.id,
        items,
        undefined,
        options,
        undefined,
        params.queue?.name
      );
    },
  };

  registerTaskLifecycleHooks(params.id, params);

  resourceCatalog.registerTaskMetadata({
    id: params.id,
    description: params.description,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: typeof params.machine === "string" ? { preset: params.machine } : params.machine,
    maxDuration: params.maxDuration,
    payloadSchema: params.jsonSchema,
    fns: {
      run: params.run,
    },
  });

  const queue = params.queue;

  if (queue && typeof queue.name === "string") {
    resourceCatalog.registerQueueMetadata({
      name: queue.name,
      concurrencyLimit: queue.concurrencyLimit,
    });
  }

  // @ts-expect-error
  task[Symbol.for("trigger.dev/task")] = true;

  return task;
}

/**
 * @deprecated use ai.tool() instead
 */
export function createToolTask<
  TIdentifier extends string,
  TParameters extends ToolTaskParameters,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskWithToolOptions<TIdentifier, TParameters, TOutput, TInitOutput>
): ToolTask<TIdentifier, TParameters, TOutput> {
  const task = createSchemaTask({
    ...params,
    schema: convertToolParametersToSchema(params.parameters),
  });

  return {
    ...task,
    tool: {
      parameters: params.parameters,
      description: params.description,
      execute: async (args: inferToolParameters<TParameters>) => {
        return task.triggerAndWait(args).unwrap();
      },
    },
  };
}

export function createSchemaTask<
  TIdentifier extends string,
  TSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskWithSchemaOptions<TIdentifier, TSchema, TOutput, TInitOutput>
): TaskWithSchema<TIdentifier, TSchema, TOutput> {
  const parsePayload = params.schema
    ? getSchemaParseFn<inferSchemaIn<TSchema>>(params.schema)
    : undefined;

  const task: TaskWithSchema<TIdentifier, TSchema, TOutput> = {
    id: params.id,
    description: params.description,
    schema: params.schema,
    trigger: async (payload, options, requestOptions) => {
      return await trigger_internal<RunTypes<TIdentifier, inferSchemaIn<TSchema>, TOutput>>(
        "trigger()",
        params.id,
        payload,
        parsePayload,
        {
          queue: params.queue?.name,
          ...options,
        },
        requestOptions
      );
    },
    batchTrigger: async (items, options, requestOptions) => {
      return await batchTrigger_internal<RunTypes<TIdentifier, inferSchemaIn<TSchema>, TOutput>>(
        "batchTrigger()",
        params.id,
        items,
        options,
        parsePayload,
        requestOptions,
        params.queue?.name
      );
    },
    triggerAndWait: (payload, options) => {
      return new TaskRunPromise<TIdentifier, TOutput>((resolve, reject) => {
        triggerAndWait_internal<TIdentifier, inferSchemaIn<TSchema>, TOutput>(
          "triggerAndWait()",
          params.id,
          payload,
          parsePayload,
          {
            queue: params.queue?.name,
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
    batchTriggerAndWait: async (items, options) => {
      return await batchTriggerAndWait_internal<TIdentifier, inferSchemaIn<TSchema>, TOutput>(
        "batchTriggerAndWait()",
        params.id,
        items,
        parsePayload,
        options,
        undefined,
        params.queue?.name
      );
    },
  };

  registerTaskLifecycleHooks(params.id, params);

  resourceCatalog.registerTaskMetadata({
    id: params.id,
    description: params.description,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: typeof params.machine === "string" ? { preset: params.machine } : params.machine,
    maxDuration: params.maxDuration,
    fns: {
      run: params.run,
      parsePayload,
    },
    schema: params.schema,
  });

  const queue = params.queue;

  if (queue && typeof queue.name === "string") {
    resourceCatalog.registerQueueMetadata({
      name: queue.name,
      concurrencyLimit: queue.concurrencyLimit,
    });
  }

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
  options?: TriggerOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<RunHandleFromTypes<InferRunTypes<TTask>>> {
  return await trigger_internal<InferRunTypes<TTask>>(
    "tasks.trigger()",
    id,
    payload,
    undefined,
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
  options?: TriggerAndWaitOptions,
  requestOptions?: ApiRequestOptions
): TaskRunPromise<TaskIdentifier<TTask>, TaskOutput<TTask>> {
  return new TaskRunPromise<TaskIdentifier<TTask>, TaskOutput<TTask>>((resolve, reject) => {
    triggerAndWait_internal<TaskIdentifier<TTask>, TaskPayload<TTask>, TaskOutput<TTask>>(
      "tasks.triggerAndWait()",
      id,
      payload,
      undefined,
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
  options?: BatchTriggerAndWaitOptions,
  requestOptions?: ApiRequestOptions
): Promise<BatchResult<TaskIdentifier<TTask>, TaskOutput<TTask>>> {
  return await batchTriggerAndWait_internal<
    TaskIdentifier<TTask>,
    TaskPayload<TTask>,
    TaskOutput<TTask>
  >("tasks.batchTriggerAndWait()", id, items, undefined, options, requestOptions);
}

export async function batchTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  items: Array<BatchItem<TaskPayload<TTask>>>,
  options?: BatchTriggerOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchRunHandleFromTypes<InferRunTypes<TTask>>> {
  return await batchTrigger_internal<InferRunTypes<TTask>>(
    "tasks.batchTrigger()",
    id,
    items,
    options,
    undefined,
    requestOptions
  );
}

/**
 * Triggers multiple runs of different tasks with specified payloads and options.
 *
 * @template TTask - The type of task(s) to be triggered, extends AnyTask
 *
 * @param {Array<BatchByIdItem<InferRunTypes<TTask>>>} items - Array of task items to trigger
 * @param {BatchTriggerOptions} [options] - Optional batch-level trigger options
 * @param {TriggerApiRequestOptions} [requestOptions] - Optional API request configuration
 *
 * @returns {Promise<BatchRunHandleFromTypes<InferRunTypes<TTask>>>} A promise that resolves with the batch run handle
 * containing batch ID, cached status, idempotency info, runs, and public access token
 *
 * @example
 * ```ts
 * import { batch } from "@trigger.dev/sdk/v3";
 * import type { myTask1, myTask2 } from "~/trigger/myTasks";
 *
 * // Trigger multiple tasks with different payloads
 * const result = await batch.trigger<typeof myTask1 | typeof myTask2>([
 *   {
 *     id: "my-task-1",
 *     payload: { some: "data" },
 *     options: {
 *       queue: "default",
 *       concurrencyKey: "key",
 *       idempotencyKey: "unique-key",
 *       delay: "5m",
 *       tags: ["tag1", "tag2"]
 *     }
 *   },
 *   {
 *     id: "my-task-2",
 *     payload: { other: "data" }
 *   }
 * ]);
 * ```
 *
 * @description
 * Each task item in the array can include:
 * - `id`: The unique identifier of the task
 * - `payload`: The data to pass to the task
 * - `options`: Optional task-specific settings including:
 *   - `queue`: Specify a queue for the task
 *   - `concurrencyKey`: Control concurrent execution
 *   - `idempotencyKey`: Prevent duplicate runs
 *   - `idempotencyKeyTTL`: Time-to-live for idempotency key
 *   - `delay`: Delay before task execution
 *   - `ttl`: Time-to-live for the task
 *   - `tags`: Array of tags for the task
 *   - `maxAttempts`: Maximum retry attempts
 *   - `metadata`: Additional metadata
 *   - `maxDuration`: Maximum execution duration
 */
export async function batchTriggerById<TTask extends AnyTask>(
  items: Array<BatchByIdItem<InferRunTypes<TTask>>>,
  options?: BatchTriggerOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchRunHandleFromTypes<InferRunTypes<TTask>>> {
  const apiClient = apiClientManager.clientOrThrow();

  const response = await apiClient.batchTriggerV3(
    {
      items: await Promise.all(
        items.map(async (item, index) => {
          const taskMetadata = resourceCatalog.getTask(item.id);

          const parsedPayload = taskMetadata?.fns.parsePayload
            ? await taskMetadata?.fns.parsePayload(item.payload)
            : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          const batchItemIdempotencyKey = await makeIdempotencyKey(
            flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
          );

          return {
            task: item.id,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue ? { name: item.options.queue } : undefined,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              idempotencyKey:
                (await makeIdempotencyKey(item.options?.idempotencyKey)) ?? batchItemIdempotencyKey,
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
              machine: item.options?.machine,
              priority: item.options?.priority,
              region: item.options?.region,
              lockToVersion: item.options?.version ?? getEnvVar("TRIGGER_VERSION"),
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
      parentRunId: taskContext.ctx?.run.id,
    },
    {
      spanParentAsLink: true,
      processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
    },
    {
      name: "batch.trigger()",
      tracer,
      icon: "trigger",
      onResponseBody(body, span) {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          if ("id" in body && typeof body.id === "string") {
            span.setAttribute("batchId", body.id);
          }

          if ("runCount" in body && typeof body.runCount === "number") {
            span.setAttribute("runCount", body.runCount);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    runCount: response.runCount,
    publicAccessToken: response.publicAccessToken,
  };

  return handle as BatchRunHandleFromTypes<InferRunTypes<TTask>>;
}

/**
 * Triggers multiple tasks and waits for all of them to complete before returning their results.
 * This function must be called from within a task.run() context.
 *
 * @template TTask - Union type of tasks to be triggered, extends AnyTask
 *
 * @param {Array<BatchByIdAndWaitItem<InferRunTypes<TTask>>>} items - Array of task items to trigger
 * @param {TriggerApiRequestOptions} [requestOptions] - Optional API request configuration
 *
 * @returns {Promise<BatchByIdResult<TTask>>} A promise that resolves with the batch results, including
 * success/failure status and strongly-typed outputs for each task
 *
 * @throws {Error} If called outside of a task.run() context
 * @throws {Error} If no API client is configured
 *
 * @example
 * ```ts
 * import { batch, task } from "@trigger.dev/sdk/v3";
 *
 * export const parentTask = task({
 *   id: "parent-task",
 *   run: async (payload: string) => {
 *     const results = await batch.triggerAndWait<typeof childTask1 | typeof childTask2>([
 *       {
 *         id: "child-task-1",
 *         payload: { foo: "World" },
 *         options: {
 *           queue: "default",
 *           delay: "5m",
 *           tags: ["batch", "child1"]
 *         }
 *       },
 *       {
 *         id: "child-task-2",
 *         payload: { bar: 42 }
 *       }
 *     ]);
 *
 *     // Type-safe result handling
 *     for (const result of results) {
 *       if (result.ok) {
 *         switch (result.taskIdentifier) {
 *           case "child-task-1":
 *             console.log("Child task 1 output:", result.output); // string type
 *             break;
 *           case "child-task-2":
 *             console.log("Child task 2 output:", result.output); // number type
 *             break;
 *         }
 *       } else {
 *         console.error("Task failed:", result.error);
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @description
 * Each task item in the array can include:
 * - `id`: The task identifier (must match one of the tasks in the union type)
 * - `payload`: Strongly-typed payload matching the task's input type
 * - `options`: Optional task-specific settings including:
 *   - `queue`: Specify a queue for the task
 *   - `concurrencyKey`: Control concurrent execution
 *   - `delay`: Delay before task execution
 *   - `ttl`: Time-to-live for the task
 *   - `tags`: Array of tags for the task
 *   - `maxAttempts`: Maximum retry attempts
 *   - `metadata`: Additional metadata
 *   - `maxDuration`: Maximum execution duration
 *
 * The function provides full type safety for:
 * - Task IDs
 * - Payload types
 * - Return value types
 * - Error handling
 */
export async function batchTriggerByIdAndWait<TTask extends AnyTask>(
  items: Array<BatchByIdAndWaitItem<InferRunTypes<TTask>>>,
  options?: BatchTriggerAndWaitOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchByIdResult<TTask>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.clientOrThrow();

  return await tracer.startActiveSpan(
    "batch.triggerAndWait()",
    async (span) => {
      const response = await apiClient.batchTriggerV3(
        {
          items: await Promise.all(
            items.map(async (item, index) => {
              const taskMetadata = resourceCatalog.getTask(item.id);

              const parsedPayload = taskMetadata?.fns.parsePayload
                ? await taskMetadata?.fns.parsePayload(item.payload)
                : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              const batchItemIdempotencyKey = await makeIdempotencyKey(
                flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
              );

              return {
                task: item.id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue ? { name: item.options.queue } : undefined,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  idempotencyKey:
                    (await makeIdempotencyKey(item.options?.idempotencyKey)) ??
                    batchItemIdempotencyKey,
                  idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
                  machine: item.options?.machine,
                  priority: item.options?.priority,
                  region: item.options?.region,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          parentRunId: ctx.run.id,
          resumeParentOnCompletion: true,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runCount);

      const result = await runtime.waitForBatch({
        id: response.id,
        runCount: response.runCount,
        ctx,
      });

      const runs = await handleBatchTaskRunExecutionResultV2(result.items);

      return {
        id: result.id,
        runs,
      } as BatchByIdResult<TTask>;
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
      },
    }
  );
}

/**
 * Triggers multiple tasks and waits for all of them to complete before returning their results.
 * This function must be called from within a task.run() context.
 *
 * @template TTask - Union type of tasks to be triggered, extends AnyTask
 *
 * @param {Array<BatchByIdAndWaitItem<InferRunTypes<TTask>>>} items - Array of task items to trigger
 * @param {TriggerApiRequestOptions} [requestOptions] - Optional API request configuration
 *
 * @returns {Promise<BatchByIdResult<TTask>>} A promise that resolves with the batch results, including
 * success/failure status and strongly-typed outputs for each task
 *
 * @throws {Error} If called outside of a task.run() context
 * @throws {Error} If no API client is configured
 *
 * @example
 * ```ts
 * import { batch, task } from "@trigger.dev/sdk/v3";
 *
 * export const parentTask = task({
 *   id: "parent-task",
 *   run: async (payload: string) => {
 *     const results = await batch.triggerAndWait<typeof childTask1 | typeof childTask2>([
 *       {
 *         id: "child-task-1",
 *         payload: { foo: "World" },
 *         options: {
 *           queue: "default",
 *           delay: "5m",
 *           tags: ["batch", "child1"]
 *         }
 *       },
 *       {
 *         id: "child-task-2",
 *         payload: { bar: 42 }
 *       }
 *     ]);
 *
 *     // Type-safe result handling
 *     for (const result of results) {
 *       if (result.ok) {
 *         switch (result.taskIdentifier) {
 *           case "child-task-1":
 *             console.log("Child task 1 output:", result.output); // string type
 *             break;
 *           case "child-task-2":
 *             console.log("Child task 2 output:", result.output); // number type
 *             break;
 *         }
 *       } else {
 *         console.error("Task failed:", result.error);
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @description
 * Each task item in the array can include:
 * - `id`: The task identifier (must match one of the tasks in the union type)
 * - `payload`: Strongly-typed payload matching the task's input type
 * - `options`: Optional task-specific settings including:
 *   - `queue`: Specify a queue for the task
 *   - `concurrencyKey`: Control concurrent execution
 *   - `delay`: Delay before task execution
 *   - `ttl`: Time-to-live for the task
 *   - `tags`: Array of tags for the task
 *   - `maxAttempts`: Maximum retry attempts
 *   - `metadata`: Additional metadata
 *   - `maxDuration`: Maximum execution duration
 *
 * The function provides full type safety for:
 * - Task IDs
 * - Payload types
 * - Return value types
 * - Error handling
 */
export async function batchTriggerTasks<TTasks extends readonly AnyTask[]>(
  items: {
    [K in keyof TTasks]: BatchByTaskItem<TTasks[K]>;
  },
  options?: BatchTriggerOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchTasksRunHandleFromTypes<TTasks>> {
  const apiClient = apiClientManager.clientOrThrow();

  const response = await apiClient.batchTriggerV3(
    {
      items: await Promise.all(
        items.map(async (item, index) => {
          const taskMetadata = resourceCatalog.getTask(item.task.id);

          const parsedPayload = taskMetadata?.fns.parsePayload
            ? await taskMetadata?.fns.parsePayload(item.payload)
            : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          const batchItemIdempotencyKey = await makeIdempotencyKey(
            flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
          );

          return {
            task: item.task.id,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue ? { name: item.options.queue } : undefined,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              idempotencyKey:
                (await makeIdempotencyKey(item.options?.idempotencyKey)) ?? batchItemIdempotencyKey,
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
              machine: item.options?.machine,
              priority: item.options?.priority,
              region: item.options?.region,
              lockToVersion: item.options?.version ?? getEnvVar("TRIGGER_VERSION"),
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
      parentRunId: taskContext.ctx?.run.id,
    },
    {
      spanParentAsLink: true,
      processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
    },
    {
      name: "batch.triggerByTask()",
      tracer,
      icon: "trigger",
      onResponseBody(body, span) {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          if ("id" in body && typeof body.id === "string") {
            span.setAttribute("batchId", body.id);
          }

          if ("runCount" in body && typeof body.runCount === "number") {
            span.setAttribute("runCount", body.runCount);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    runCount: response.runCount,
    publicAccessToken: response.publicAccessToken,
  };

  return handle as unknown as BatchTasksRunHandleFromTypes<TTasks>;
}

/**
 * Triggers multiple tasks and waits for all of them to complete before returning their results.
 * This function must be called from within a task.run() context.
 *
 * @template TTask - Union type of tasks to be triggered, extends AnyTask
 *
 * @param {Array<BatchByIdAndWaitItem<InferRunTypes<TTask>>>} items - Array of task items to trigger
 * @param {TriggerApiRequestOptions} [requestOptions] - Optional API request configuration
 *
 * @returns {Promise<BatchByIdResult<TTask>>} A promise that resolves with the batch results, including
 * success/failure status and strongly-typed outputs for each task
 *
 * @throws {Error} If called outside of a task.run() context
 * @throws {Error} If no API client is configured
 *
 * @example
 * ```ts
 * import { batch, task } from "@trigger.dev/sdk/v3";
 *
 * export const parentTask = task({
 *   id: "parent-task",
 *   run: async (payload: string) => {
 *     const results = await batch.triggerAndWait<typeof childTask1 | typeof childTask2>([
 *       {
 *         id: "child-task-1",
 *         payload: { foo: "World" },
 *         options: {
 *           queue: "default",
 *           delay: "5m",
 *           tags: ["batch", "child1"]
 *         }
 *       },
 *       {
 *         id: "child-task-2",
 *         payload: { bar: 42 }
 *       }
 *     ]);
 *
 *     // Type-safe result handling
 *     for (const result of results) {
 *       if (result.ok) {
 *         switch (result.taskIdentifier) {
 *           case "child-task-1":
 *             console.log("Child task 1 output:", result.output); // string type
 *             break;
 *           case "child-task-2":
 *             console.log("Child task 2 output:", result.output); // number type
 *             break;
 *         }
 *       } else {
 *         console.error("Task failed:", result.error);
 *       }
 *     }
 *   }
 * });
 * ```
 *
 * @description
 * Each task item in the array can include:
 * - `id`: The task identifier (must match one of the tasks in the union type)
 * - `payload`: Strongly-typed payload matching the task's input type
 * - `options`: Optional task-specific settings including:
 *   - `queue`: Specify a queue for the task
 *   - `concurrencyKey`: Control concurrent execution
 *   - `delay`: Delay before task execution
 *   - `ttl`: Time-to-live for the task
 *   - `tags`: Array of tags for the task
 *   - `maxAttempts`: Maximum retry attempts
 *   - `metadata`: Additional metadata
 *   - `maxDuration`: Maximum execution duration
 *
 * The function provides full type safety for:
 * - Task IDs
 * - Payload types
 * - Return value types
 * - Error handling
 */
export async function batchTriggerAndWaitTasks<TTasks extends readonly AnyTask[]>(
  items: {
    [K in keyof TTasks]: BatchByTaskAndWaitItem<TTasks[K]>;
  },
  options?: BatchTriggerAndWaitOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchByTaskResult<TTasks>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.clientOrThrow();

  return await tracer.startActiveSpan(
    "batch.triggerByTaskAndWait()",
    async (span) => {
      const response = await apiClient.batchTriggerV3(
        {
          items: await Promise.all(
            items.map(async (item, index) => {
              const taskMetadata = resourceCatalog.getTask(item.task.id);

              const parsedPayload = taskMetadata?.fns.parsePayload
                ? await taskMetadata?.fns.parsePayload(item.payload)
                : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              const batchItemIdempotencyKey = await makeIdempotencyKey(
                flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
              );

              return {
                task: item.task.id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue ? { name: item.options.queue } : undefined,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  idempotencyKey:
                    (await makeIdempotencyKey(item.options?.idempotencyKey)) ??
                    batchItemIdempotencyKey,
                  idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
                  machine: item.options?.machine,
                  priority: item.options?.priority,
                  region: item.options?.region,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          parentRunId: ctx.run.id,
          resumeParentOnCompletion: true,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runCount);

      const result = await runtime.waitForBatch({
        id: response.id,
        runCount: response.runCount,
        ctx,
      });

      const runs = await handleBatchTaskRunExecutionResultV2(result.items);

      return {
        id: result.id,
        runs,
      } as BatchByTaskResult<TTasks>;
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
      },
    }
  );
}

async function trigger_internal<TRunTypes extends AnyRunTypes>(
  name: string,
  id: TRunTypes["taskIdentifier"],
  payload: TRunTypes["payload"],
  parsePayload?: SchemaParseFn<TRunTypes["payload"]>,
  options?: TriggerOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<RunHandleFromTypes<TRunTypes>> {
  const apiClient = apiClientManager.clientOrThrow();

  const parsedPayload = parsePayload ? await parsePayload(payload) : payload;

  const payloadPacket = await stringifyIO(parsedPayload);

  const handle = await apiClient.triggerTask(
    id,
    {
      payload: payloadPacket.data,
      options: {
        queue: options?.queue ? { name: options.queue } : undefined,
        concurrencyKey: options?.concurrencyKey,
        test: taskContext.ctx?.run.isTest,
        payloadType: payloadPacket.dataType,
        idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
        idempotencyKeyTTL: options?.idempotencyKeyTTL,
        delay: options?.delay,
        ttl: options?.ttl,
        tags: options?.tags,
        maxAttempts: options?.maxAttempts,
        metadata: options?.metadata,
        maxDuration: options?.maxDuration,
        parentRunId: taskContext.ctx?.run.id,
        machine: options?.machine,
        priority: options?.priority,
        region: options?.region,
        lockToVersion: options?.version ?? getEnvVar("TRIGGER_VERSION"),
      },
    },
    {
      spanParentAsLink: true,
    },
    {
      name,
      tracer,
      icon: "trigger",
      onResponseBody: (body, span) => {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          if ("id" in body && typeof body.id === "string") {
            span.setAttribute("runId", body.id);
          }
        }
      },
      ...requestOptions,
    }
  );

  return handle as RunHandleFromTypes<TRunTypes>;
}

async function batchTrigger_internal<TRunTypes extends AnyRunTypes>(
  name: string,
  taskIdentifier: TRunTypes["taskIdentifier"],
  items: Array<BatchItem<TRunTypes["payload"]>>,
  options?: BatchTriggerOptions,
  parsePayload?: SchemaParseFn<TRunTypes["payload"]>,
  requestOptions?: TriggerApiRequestOptions,
  queue?: string
): Promise<BatchRunHandleFromTypes<TRunTypes>> {
  const apiClient = apiClientManager.clientOrThrow();

  const ctx = taskContext.ctx;

  const response = await apiClient.batchTriggerV3(
    {
      items: await Promise.all(
        items.map(async (item, index) => {
          const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          const batchItemIdempotencyKey = await makeIdempotencyKey(
            flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
          );

          return {
            task: taskIdentifier,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue
                ? { name: item.options.queue }
                : queue
                ? { name: queue }
                : undefined,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              idempotencyKey:
                (await makeIdempotencyKey(item.options?.idempotencyKey)) ?? batchItemIdempotencyKey,
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
              machine: item.options?.machine,
              priority: item.options?.priority,
              region: item.options?.region,
              lockToVersion: item.options?.version ?? getEnvVar("TRIGGER_VERSION"),
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
      parentRunId: ctx?.run.id,
    },
    {
      spanParentAsLink: true,
      processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
    },
    {
      name,
      tracer,
      icon: "trigger",
      onResponseBody(body, span) {
        if (body && typeof body === "object" && !Array.isArray(body)) {
          if ("id" in body && typeof body.id === "string") {
            span.setAttribute("batchId", body.id);
          }

          if ("runCount" in body && Array.isArray(body.runCount)) {
            span.setAttribute("runCount", body.runCount);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    runCount: response.runCount,
    publicAccessToken: response.publicAccessToken,
  };

  return handle as BatchRunHandleFromTypes<TRunTypes>;
}

async function triggerAndWait_internal<TIdentifier extends string, TPayload, TOutput>(
  name: string,
  id: TIdentifier,
  payload: TPayload,
  parsePayload?: SchemaParseFn<TPayload>,
  options?: TriggerAndWaitOptions,
  requestOptions?: ApiRequestOptions
): Promise<TaskRunResult<TIdentifier, TOutput>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("triggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.clientOrThrow();

  const parsedPayload = parsePayload ? await parsePayload(payload) : payload;

  const payloadPacket = await stringifyIO(parsedPayload);

  return await tracer.startActiveSpan(
    name,
    async (span) => {
      const response = await apiClient.triggerTask(
        id,
        {
          payload: payloadPacket.data,
          options: {
            lockToVersion: taskContext.worker?.version, // Lock to current version because we're waiting for it to finish
            queue: options?.queue ? { name: options.queue } : undefined,
            concurrencyKey: options?.concurrencyKey,
            test: taskContext.ctx?.run.isTest,
            payloadType: payloadPacket.dataType,
            delay: options?.delay,
            ttl: options?.ttl,
            tags: options?.tags,
            maxAttempts: options?.maxAttempts,
            metadata: options?.metadata,
            maxDuration: options?.maxDuration,
            resumeParentOnCompletion: true,
            parentRunId: ctx.run.id,
            idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
            idempotencyKeyTTL: options?.idempotencyKeyTTL,
            machine: options?.machine,
            priority: options?.priority,
            region: options?.region,
          },
        },
        {},
        requestOptions
      );

      span.setAttribute("runId", response.id);

      const result = await runtime.waitForTask({
        id: response.id,
        ctx,
      });

      return await handleTaskRunExecutionResult<TIdentifier, TOutput>(result, id);
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
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

async function batchTriggerAndWait_internal<TIdentifier extends string, TPayload, TOutput>(
  name: string,
  id: TIdentifier,
  items: Array<BatchTriggerAndWaitItem<TPayload>>,
  parsePayload?: SchemaParseFn<TPayload>,
  options?: BatchTriggerAndWaitOptions,
  requestOptions?: ApiRequestOptions,
  queue?: string
): Promise<BatchResult<TIdentifier, TOutput>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.clientOrThrow();

  return await tracer.startActiveSpan(
    name,
    async (span) => {
      const response = await apiClient.batchTriggerV3(
        {
          items: await Promise.all(
            items.map(async (item, index) => {
              const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              const batchItemIdempotencyKey = await makeIdempotencyKey(
                flattenIdempotencyKey([options?.idempotencyKey, `${index}`])
              );

              return {
                task: id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue
                    ? { name: item.options.queue }
                    : queue
                    ? { name: queue }
                    : undefined,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  idempotencyKey:
                    (await makeIdempotencyKey(item.options?.idempotencyKey)) ??
                    batchItemIdempotencyKey,
                  idempotencyKeyTTL: item.options?.idempotencyKeyTTL ?? options?.idempotencyKeyTTL,
                  machine: item.options?.machine,
                  priority: item.options?.priority,
                  region: item.options?.region,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          resumeParentOnCompletion: true,
          parentRunId: ctx.run.id,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runCount);

      const result = await runtime.waitForBatch({
        id: response.id,
        runCount: response.runCount,
        ctx,
      });

      const runs = await handleBatchTaskRunExecutionResult<TIdentifier, TOutput>(result.items, id);

      return {
        id: result.id,
        runs,
      };
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
        [SemanticInternalAttributes.STYLE_ICON]: "trigger",
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

async function handleBatchTaskRunExecutionResult<TIdentifier extends string, TOutput>(
  items: Array<TaskRunExecutionResult>,
  taskIdentifier: TIdentifier
): Promise<Array<TaskRunResult<TIdentifier, TOutput>>> {
  const someObjectStoreOutputs = items.some(
    (item) => item.ok && item.outputType === "application/store"
  );

  if (!someObjectStoreOutputs) {
    const results = await Promise.all(
      items.map(async (item) => {
        return await handleTaskRunExecutionResult<TIdentifier, TOutput>(item, taskIdentifier);
      })
    );

    return results;
  }

  return await tracer.startActiveSpan(
    "store.downloadPayloads",
    async (span) => {
      const results = await Promise.all(
        items.map(async (item) => {
          return await handleTaskRunExecutionResult<TIdentifier, TOutput>(item, taskIdentifier);
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

async function handleBatchTaskRunExecutionResultV2(
  items: Array<TaskRunExecutionResult>
): Promise<Array<AnyTaskRunResult>> {
  const someObjectStoreOutputs = items.some(
    (item) => item.ok && item.outputType === "application/store"
  );

  if (!someObjectStoreOutputs) {
    const results = await Promise.all(
      items.map(async (item) => {
        return await handleTaskRunExecutionResult(item, item.taskIdentifier ?? "unknown");
      })
    );

    return results;
  }

  return await tracer.startActiveSpan(
    "store.downloadPayloads",
    async (span) => {
      const results = await Promise.all(
        items.map(async (item) => {
          return await handleTaskRunExecutionResult(item, item.taskIdentifier ?? "unknown");
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

async function handleTaskRunExecutionResult<TIdentifier extends string = string, TOutput = any>(
  execution: TaskRunExecutionResult,
  taskIdentifier: TIdentifier
): Promise<TaskRunResult<TIdentifier, TOutput>> {
  if (execution.ok) {
    const outputPacket = { data: execution.output, dataType: execution.outputType };
    const importedPacket = await conditionallyImportPacket(outputPacket, tracer);

    return {
      ok: true,
      id: execution.id,
      taskIdentifier: (execution.taskIdentifier ?? taskIdentifier) as TIdentifier,
      output: await parsePacket(importedPacket),
    };
  } else {
    return {
      ok: false,
      id: execution.id,
      taskIdentifier: (execution.taskIdentifier ?? taskIdentifier) as TIdentifier,
      error: createErrorTaskError(execution.error),
    };
  }
}

function registerTaskLifecycleHooks<
  TIdentifier extends string,
  TInput = void,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(taskId: TIdentifier, params: TaskOptions<TIdentifier, TInput, TOutput, TInitOutput>) {
  if (params.init) {
    lifecycleHooks.registerTaskInitHook(taskId, {
      fn: params.init as AnyOnInitHookFunction,
    });
  }

  if (params.onStart) {
    lifecycleHooks.registerTaskStartHook(taskId, {
      fn: params.onStart as AnyOnStartHookFunction,
    });
  }

  if (params.onFailure) {
    lifecycleHooks.registerTaskFailureHook(taskId, {
      fn: params.onFailure as AnyOnFailureHookFunction,
    });
  }

  if (params.onSuccess) {
    lifecycleHooks.registerTaskSuccessHook(taskId, {
      fn: params.onSuccess as AnyOnSuccessHookFunction,
    });
  }

  if (params.onComplete) {
    lifecycleHooks.registerTaskCompleteHook(taskId, {
      fn: params.onComplete as AnyOnCompleteHookFunction,
    });
  }

  if (params.onWait) {
    lifecycleHooks.registerTaskWaitHook(taskId, {
      fn: params.onWait as AnyOnWaitHookFunction,
    });
  }

  if (params.onResume) {
    lifecycleHooks.registerTaskResumeHook(taskId, {
      fn: params.onResume as AnyOnResumeHookFunction,
    });
  }

  if (params.catchError) {
    // We don't need to use an adapter here because catchError is the new version of handleError
    lifecycleHooks.registerTaskCatchErrorHook(taskId, {
      fn: params.catchError as AnyOnCatchErrorHookFunction,
    });
  }

  if (params.handleError) {
    lifecycleHooks.registerTaskCatchErrorHook(taskId, {
      fn: params.handleError as AnyOnCatchErrorHookFunction,
    });
  }

  if (params.middleware) {
    lifecycleHooks.registerTaskMiddlewareHook(taskId, {
      fn: params.middleware as AnyOnMiddlewareHookFunction,
    });
  }

  if (params.cleanup) {
    lifecycleHooks.registerTaskCleanupHook(taskId, {
      fn: params.cleanup as AnyOnCleanupHookFunction,
    });
  }

  if (params.onCancel) {
    lifecycleHooks.registerTaskCancelHook(taskId, {
      fn: params.onCancel as AnyOnCancelHookFunction,
    });
  }
}
