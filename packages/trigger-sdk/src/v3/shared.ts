import { SpanKind } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGING_DESTINATION,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
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
} from "@trigger.dev/core/v3";
import { PollOptions, runs } from "./runs.js";
import { tracer } from "./tracer.js";

import type {
  AnyRunHandle,
  AnyRunTypes,
  AnyTask,
  BatchItem,
  BatchResult,
  BatchRunHandle,
  BatchRunHandleFromTypes,
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

      return new TaskRunPromise<TOutput>((resolve, reject) => {
        triggerAndWait_internal<TInput, TOutput>(
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
    batchTriggerAndWait: async (items) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTriggerAndWait_internal<TInput, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTriggerAndWait()`
          : `batchTriggerAndWait()`,
        params.id,
        items,
        undefined,
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
    machine: params.machine,
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

      return new TaskRunPromise<TOutput>((resolve, reject) => {
        triggerAndWait_internal<inferSchemaIn<TSchema>, TOutput>(
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
    batchTriggerAndWait: async (items) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTriggerAndWait_internal<inferSchemaIn<TSchema>, TOutput>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTriggerAndWait()`
          : `batchTriggerAndWait()`,
        params.id,
        items,
        parsePayload,
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
    machine: params.machine,
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
): TaskRunPromise<TaskOutput<TTask>> {
  return new TaskRunPromise<TaskOutput<TTask>>((resolve, reject) => {
    triggerAndWait_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
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
  requestOptions?: ApiRequestOptions
): Promise<BatchResult<TaskOutput<TTask>>> {
  return await batchTriggerAndWait_internal<TaskPayload<TTask>, TaskOutput<TTask>>(
    "tasks.batchTriggerAndWait()",
    id,
    items,
    undefined,
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
        body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          "id" in body &&
          typeof body.id === "string" &&
          span.setAttribute("runId", body.id);
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
            },
          };
        })
      ),
    },
    {
      spanParentAsLink: true,
      idempotencyKey: await makeIdempotencyKey(options?.idempotencyKey),
      idempotencyKeyTTL: options?.idempotencyKeyTTL,
    },
    {
      name,
      tracer,
      icon: "trigger",
      onResponseBody(body, span) {
        if (
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          "id" in body &&
          typeof body.id === "string"
        ) {
          span.setAttribute("batchId", body.id);
        }

        if (
          body &&
          typeof body === "object" &&
          !Array.isArray(body) &&
          "runs" in body &&
          Array.isArray(body.runs)
        ) {
          span.setAttribute("runCount", body.runs.length);
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

async function triggerAndWait_internal<TPayload, TOutput>(
  name: string,
  id: string,
  payload: TPayload,
  parsePayload?: SchemaParseFn<TPayload>,
  options?: TriggerAndWaitOptions,
  requestOptions?: ApiRequestOptions
): Promise<TaskRunResult<TOutput>> {
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

      return await handleTaskRunExecutionResult<TOutput>(result, id);
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
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
  items: Array<BatchTriggerAndWaitItem<TPayload>>,
  parsePayload?: SchemaParseFn<TPayload>,
  requestOptions?: ApiRequestOptions,
  queue?: QueueOptions
): Promise<BatchResult<TOutput>> {
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
                },
              };
            })
          ),
          dependentAttempt: ctx.attempt.id,
        },
        {},
        requestOptions
      );

      span.setAttribute("batchId", response.id);
      span.setAttribute("runCount", response.runs.length);

      const result = await runtime.waitForBatch({
        id: response.id,
        runs: response.runs.map((run) => run.id),
        ctx,
      });

      const runs = await handleBatchTaskRunExecutionResult<TOutput>(result.items, id);

      return {
        id: result.id,
        runs,
      };
    },
    {
      kind: SpanKind.PRODUCER,
      attributes: {
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
  items: Array<TaskRunExecutionResult>,
  taskIdentifier: string
): Promise<Array<TaskRunResult<TOutput>>> {
  const someObjectStoreOutputs = items.some(
    (item) => item.ok && item.outputType === "application/store"
  );

  if (!someObjectStoreOutputs) {
    const results = await Promise.all(
      items.map(async (item) => {
        return await handleTaskRunExecutionResult<TOutput>(item, taskIdentifier);
      })
    );

    return results;
  }

  return await tracer.startActiveSpan(
    "store.downloadPayloads",
    async (span) => {
      const results = await Promise.all(
        items.map(async (item) => {
          return await handleTaskRunExecutionResult<TOutput>(item, taskIdentifier);
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
  execution: TaskRunExecutionResult,
  taskIdentifier: string
): Promise<TaskRunResult<TOutput>> {
  if (execution.ok) {
    const outputPacket = { data: execution.output, dataType: execution.outputType };
    const importedPacket = await conditionallyImportPacket(outputPacket, tracer);

    return {
      ok: true,
      id: execution.id,
      taskIdentifier: execution.taskIdentifier ?? taskIdentifier,
      output: await parsePacket(importedPacket),
    };
  } else {
    return {
      ok: false,
      id: execution.id,
      taskIdentifier: execution.taskIdentifier ?? taskIdentifier,
      error: createErrorTaskError(execution.error),
    };
  }
}
