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
  getSchemaParseFn,
  InitOutput,
  makeIdempotencyKey,
  parsePacket,
  Queue,
  QueueOptions,
  runtime,
  SemanticInternalAttributes,
  stringifyIO,
  SubtaskUnwrapError,
  taskCatalog,
  taskContext,
  TaskRunContext,
  TaskRunExecutionResult,
  TaskRunPromise,
  TaskFromIdentifier,
} from "@trigger.dev/core/v3";
import { PollOptions, runs } from "./runs.js";
import { tracer } from "./tracer.js";

import type {
  AnyRunHandle,
  AnyRunTypes,
  AnyTask,
  BatchByIdAndWaitItem,
  BatchByTaskAndWaitItem,
  BatchByIdItem,
  BatchByTaskItem,
  BatchByTaskResult,
  BatchByIdResult,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  BatchRunHandleFromTypes,
  BatchTasksRunHandleFromTypes,
  BatchTriggerAndWaitItem,
  BatchTriggerOptions,
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
  AnyTaskRunResult,
  BatchTriggerAndWaitOptions,
  BatchTriggerTaskV2RequestBody,
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
  TaskIdentifier,
  TaskOptions,
  TaskOutput,
  TaskOutputHandle,
  TaskPayload,
  TaskRunResult,
  TriggerOptions,
  TaskFromIdentifier,
};

export { SubtaskUnwrapError, TaskRunPromise };

export type Context = TaskRunContext;

export function queue(options: { name: string } & QueueOptions): Queue {
  return options;
}

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
    description: params.description,
    trigger: async (payload, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await trigger_internal<RunTypes<TIdentifier, TInput, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.trigger()`
          : `trigger()`,
        params.id,
        payload,
        undefined,
        {
          queue: customQueue,
          ...options,
        }
      );
    },
    batchTrigger: async (items, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTrigger_internal<RunTypes<TIdentifier, TInput, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTrigger()`
          : `batchTrigger()`,
        params.id,
        items,
        options,
        undefined,
        undefined,
        customQueue
      );
    },
    triggerAndWait: (payload, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return new TaskRunPromise<TIdentifier, TOutput>((resolve, reject) => {
        triggerAndWait_internal<TIdentifier, TInput, TOutput>(
          taskMetadata && taskMetadata.exportName
            ? `${taskMetadata.exportName}.triggerAndWait()`
            : `triggerAndWait()`,
          params.id,
          payload,
          undefined,
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
    batchTriggerAndWait: async (items, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTriggerAndWait_internal<TIdentifier, TInput, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTriggerAndWait()`
          : `batchTriggerAndWait()`,
        params.id,
        items,
        undefined,
        options,
        undefined,
        customQueue
      );
    },
  };

  taskCatalog.registerTaskMetadata({
    id: params.id,
    description: params.description,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: typeof params.machine === "string" ? { preset: params.machine } : params.machine,
    maxDuration: params.maxDuration,
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
  const customQueue = params.queue
    ? queue({
        name: params.queue?.name ?? `task/${params.id}`,
        ...params.queue,
      })
    : undefined;

  const parsePayload = params.schema
    ? getSchemaParseFn<inferSchemaIn<TSchema>>(params.schema)
    : undefined;

  const task: TaskWithSchema<TIdentifier, TSchema, TOutput> = {
    id: params.id,
    description: params.description,
    schema: params.schema,
    trigger: async (payload, options, requestOptions) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await trigger_internal<RunTypes<TIdentifier, inferSchemaIn<TSchema>, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.trigger()`
          : `trigger()`,
        params.id,
        payload,
        parsePayload,
        {
          queue: customQueue,
          ...options,
        },
        requestOptions
      );
    },
    batchTrigger: async (items, options, requestOptions) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTrigger_internal<RunTypes<TIdentifier, inferSchemaIn<TSchema>, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTrigger()`
          : `batchTrigger()`,
        params.id,
        items,
        options,
        parsePayload,
        requestOptions,
        customQueue
      );
    },
    triggerAndWait: (payload, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return new TaskRunPromise<TIdentifier, TOutput>((resolve, reject) => {
        triggerAndWait_internal<TIdentifier, inferSchemaIn<TSchema>, TOutput>(
          taskMetadata && taskMetadata.exportName
            ? `${taskMetadata.exportName}.triggerAndWait()`
            : `triggerAndWait()`,
          params.id,
          payload,
          parsePayload,
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
    batchTriggerAndWait: async (items, options) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTriggerAndWait_internal<TIdentifier, inferSchemaIn<TSchema>, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTriggerAndWait()`
          : `batchTriggerAndWait()`,
        params.id,
        items,
        parsePayload,
        options,
        undefined,
        customQueue
      );
    },
  };

  taskCatalog.registerTaskMetadata({
    id: params.id,
    description: params.description,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: typeof params.machine === "string" ? { preset: params.machine } : params.machine,
    maxDuration: params.maxDuration,
    fns: {
      run: params.run,
      init: params.init,
      cleanup: params.cleanup,
      middleware: params.middleware,
      handleError: params.handleError,
      onSuccess: params.onSuccess,
      onFailure: params.onFailure,
      onStart: params.onStart,
      parsePayload,
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
  options?: TriggerOptions & PollOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<RetrieveRunResult<TTask>> {
  const handle = await trigger(id, payload, options, requestOptions);

  return runs.poll(handle, options, requestOptions);
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

  const response = await apiClient.batchTriggerV2(
    {
      items: await Promise.all(
        items.map(async (item) => {
          const taskMetadata = taskCatalog.getTask(item.id);

          const parsedPayload = taskMetadata?.fns.parsePayload
            ? await taskMetadata?.fns.parsePayload(item.payload)
            : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          return {
            task: item.id,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              idempotencyKey: await makeIdempotencyKey(item.options?.idempotencyKey),
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              parentAttempt: taskContext.ctx?.attempt.id,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              machine: item.options?.machine,
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
    },
    {
      spanParentAsLink: true,
      idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
      idempotencyKeyTTL: options?.idempotencyKeyTTL,
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

          if ("runs" in body && Array.isArray(body.runs)) {
            span.setAttribute("runCount", body.runs.length);
          }

          if ("isCached" in body && typeof body.isCached === "boolean") {
            if (body.isCached) {
              console.warn(`Result is a cached response because the request was idempotent.`);
            }

            span.setAttribute("isCached", body.isCached);
          }

          if ("idempotencyKey" in body && typeof body.idempotencyKey === "string") {
            span.setAttribute("idempotencyKey", body.idempotencyKey);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    isCached: response.isCached,
    idempotencyKey: response.idempotencyKey,
    runs: response.runs,
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
      const response = await apiClient.batchTriggerV2(
        {
          items: await Promise.all(
            items.map(async (item) => {
              const taskMetadata = taskCatalog.getTask(item.id);

              const parsedPayload = taskMetadata?.fns.parsePayload
                ? await taskMetadata?.fns.parsePayload(item.payload)
                : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              return {
                task: item.id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  machine: item.options?.machine,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          dependentAttempt: ctx.attempt.id,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runs.length);
      span.setAttribute("isCached", response.isCached);

      if (response.isCached) {
        console.warn(`Result is a cached response because the request was idempotent.`);
      }

      if (response.idempotencyKey) {
        span.setAttribute("idempotencyKey", response.idempotencyKey);
      }

      const result = await runtime.waitForBatch({
        id: response.id,
        runs: response.runs.map((run) => run.id),
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

  const response = await apiClient.batchTriggerV2(
    {
      items: await Promise.all(
        items.map(async (item) => {
          const taskMetadata = taskCatalog.getTask(item.task.id);

          const parsedPayload = taskMetadata?.fns.parsePayload
            ? await taskMetadata?.fns.parsePayload(item.payload)
            : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          return {
            task: item.task.id,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              idempotencyKey: await makeIdempotencyKey(item.options?.idempotencyKey),
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              parentAttempt: taskContext.ctx?.attempt.id,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              machine: item.options?.machine,
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
    },
    {
      spanParentAsLink: true,
      idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
      idempotencyKeyTTL: options?.idempotencyKeyTTL,
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

          if ("runs" in body && Array.isArray(body.runs)) {
            span.setAttribute("runCount", body.runs.length);
          }

          if ("isCached" in body && typeof body.isCached === "boolean") {
            if (body.isCached) {
              console.warn(`Result is a cached response because the request was idempotent.`);
            }

            span.setAttribute("isCached", body.isCached);
          }

          if ("idempotencyKey" in body && typeof body.idempotencyKey === "string") {
            span.setAttribute("idempotencyKey", body.idempotencyKey);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    isCached: response.isCached,
    idempotencyKey: response.idempotencyKey,
    runs: response.runs,
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
      const response = await apiClient.batchTriggerV2(
        {
          items: await Promise.all(
            items.map(async (item) => {
              const taskMetadata = taskCatalog.getTask(item.task.id);

              const parsedPayload = taskMetadata?.fns.parsePayload
                ? await taskMetadata?.fns.parsePayload(item.payload)
                : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              return {
                task: item.task.id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  machine: item.options?.machine,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          dependentAttempt: ctx.attempt.id,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runs.length);
      span.setAttribute("isCached", response.isCached);

      if (response.isCached) {
        console.warn(`Result is a cached response because the request was idempotent.`);
      }

      if (response.idempotencyKey) {
        span.setAttribute("idempotencyKey", response.idempotencyKey);
      }

      const result = await runtime.waitForBatch({
        id: response.id,
        runs: response.runs.map((run) => run.id),
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
        queue: options?.queue,
        concurrencyKey: options?.concurrencyKey,
        test: taskContext.ctx?.run.isTest,
        payloadType: payloadPacket.dataType,
        idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
        idempotencyKeyTTL: options?.idempotencyKeyTTL,
        delay: options?.delay,
        ttl: options?.ttl,
        tags: options?.tags,
        maxAttempts: options?.maxAttempts,
        parentAttempt: taskContext.ctx?.attempt.id,
        metadata: options?.metadata,
        maxDuration: options?.maxDuration,
        machine: options?.machine,
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
  queue?: QueueOptions
): Promise<BatchRunHandleFromTypes<TRunTypes>> {
  const apiClient = apiClientManager.clientOrThrow();

  const response = await apiClient.batchTriggerV2(
    {
      items: await Promise.all(
        items.map(async (item) => {
          const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

          return {
            task: taskIdentifier,
            payload: payloadPacket.data,
            options: {
              queue: item.options?.queue ?? queue,
              concurrencyKey: item.options?.concurrencyKey,
              test: taskContext.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              idempotencyKey: await makeIdempotencyKey(item.options?.idempotencyKey),
              idempotencyKeyTTL: item.options?.idempotencyKeyTTL,
              delay: item.options?.delay,
              ttl: item.options?.ttl,
              tags: item.options?.tags,
              maxAttempts: item.options?.maxAttempts,
              parentAttempt: taskContext.ctx?.attempt.id,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
              machine: item.options?.machine,
            },
          } satisfies BatchTriggerTaskV2RequestBody["items"][0];
        })
      ),
    },
    {
      spanParentAsLink: true,
      idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
      idempotencyKeyTTL: options?.idempotencyKeyTTL,
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

          if ("runs" in body && Array.isArray(body.runs)) {
            span.setAttribute("runCount", body.runs.length);
          }

          if ("isCached" in body && typeof body.isCached === "boolean") {
            if (body.isCached) {
              console.warn(`Result is a cached response because the request was idempotent.`);
            }

            span.setAttribute("isCached", body.isCached);
          }

          if ("idempotencyKey" in body && typeof body.idempotencyKey === "string") {
            span.setAttribute("idempotencyKey", body.idempotencyKey);
          }
        }
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.id,
    isCached: response.isCached,
    idempotencyKey: response.idempotencyKey,
    runs: response.runs,
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
            dependentAttempt: ctx.attempt.id,
            lockToVersion: taskContext.worker?.version, // Lock to current version because we're waiting for it to finish
            queue: options?.queue,
            concurrencyKey: options?.concurrencyKey,
            test: taskContext.ctx?.run.isTest,
            payloadType: payloadPacket.dataType,
            delay: options?.delay,
            ttl: options?.ttl,
            tags: options?.tags,
            maxAttempts: options?.maxAttempts,
            metadata: options?.metadata,
            maxDuration: options?.maxDuration,
            machine: options?.machine,
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
  queue?: QueueOptions
): Promise<BatchResult<TIdentifier, TOutput>> {
  const ctx = taskContext.ctx;

  if (!ctx) {
    throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
  }

  const apiClient = apiClientManager.clientOrThrow();

  return await tracer.startActiveSpan(
    name,
    async (span) => {
      const response = await apiClient.batchTriggerV2(
        {
          items: await Promise.all(
            items.map(async (item) => {
              const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

              return {
                task: id,
                payload: payloadPacket.data,
                options: {
                  lockToVersion: taskContext.worker?.version,
                  queue: item.options?.queue ?? queue,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContext.ctx?.run.isTest,
                  payloadType: payloadPacket.dataType,
                  delay: item.options?.delay,
                  ttl: item.options?.ttl,
                  tags: item.options?.tags,
                  maxAttempts: item.options?.maxAttempts,
                  metadata: item.options?.metadata,
                  maxDuration: item.options?.maxDuration,
                  machine: item.options?.machine,
                },
              } satisfies BatchTriggerTaskV2RequestBody["items"][0];
            })
          ),
          dependentAttempt: ctx.attempt.id,
        },
        {
          processingStrategy: options?.triggerSequentially ? "sequential" : undefined,
        },
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runs.length);
      span.setAttribute("isCached", response.isCached);

      if (response.isCached) {
        console.warn(`Result is a cached response because the request was idempotent.`);
      }

      if (response.idempotencyKey) {
        span.setAttribute("idempotencyKey", response.idempotencyKey);
      }

      const result = await runtime.waitForBatch({
        id: response.id,
        runs: response.runs.map((run) => run.id),
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
