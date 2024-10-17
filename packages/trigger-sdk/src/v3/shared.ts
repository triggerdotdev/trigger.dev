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
  BatchTaskRunExecutionResult,
  conditionallyImportPacket,
  createErrorTaskError,
  defaultRetryOptions,
  getSchemaParseFn,
  InitOutput,
  logger,
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
import { IdempotencyKey, idempotencyKeys, isIdempotencyKey } from "./idempotencyKeys.js";
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
  InferRunTypes,
  inferSchemaIn,
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
  TaskRunOptions,
  TaskRunResult,
  TaskSchema,
  TaskWithSchemaOptions,
  TriggerApiRequestOptions,
} from "@trigger.dev/core/v3";

export type {
  AnyRunHandle,
  AnyTask,
  BatchItem,
  BatchResult,
  BatchRunHandle,
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
  TaskRunOptions,
  TaskRunResult,
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
    batchTrigger: async (items) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTrigger_internal<RunTypes<TIdentifier, TInput, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTrigger()`
          : `batchTrigger()`,
        params.id,
        items,
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

export function createSchemaTask<
  TIdentifier extends string,
  TSchema extends TaskSchema | undefined = undefined,
  TOutput = unknown,
  TInitOutput extends InitOutput = any,
>(
  params: TaskWithSchemaOptions<TIdentifier, TSchema, TOutput, TInitOutput>
): Task<TIdentifier, inferSchemaIn<TSchema>, TOutput> {
  const customQueue = params.queue
    ? queue({
        name: params.queue?.name ?? `task/${params.id}`,
        ...params.queue,
      })
    : undefined;

  const parsePayload = params.schema
    ? getSchemaParseFn<inferSchemaIn<TSchema>>(params.schema)
    : undefined;

  const task: Task<TIdentifier, inferSchemaIn<TSchema>, TOutput> = {
    id: params.id,
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
    batchTrigger: async (items, requestOptions) => {
      const taskMetadata = taskCatalog.getTaskManifest(params.id);

      return await batchTrigger_internal<RunTypes<TIdentifier, inferSchemaIn<TSchema>, TOutput>>(
        taskMetadata && taskMetadata.exportName
          ? `${taskMetadata.exportName}.batchTrigger()`
          : `batchTrigger()`,
        params.id,
        items,
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
  options?: TaskRunOptions,
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
  options?: TaskRunOptions,
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
  options?: TaskRunOptions & PollOptions,
  requestOptions?: TriggerApiRequestOptions
): Promise<RetrieveRunResult<TTask>> {
  const handle = await trigger(id, payload, options, requestOptions);

  return runs.poll(handle, options, requestOptions);
}

export async function batchTrigger<TTask extends AnyTask>(
  id: TaskIdentifier<TTask>,
  items: Array<BatchItem<TaskPayload<TTask>>>,
  requestOptions?: TriggerApiRequestOptions
): Promise<BatchRunHandleFromTypes<InferRunTypes<TTask>>> {
  return await batchTrigger_internal<InferRunTypes<TTask>>(
    "tasks.batchTrigger()",
    id,
    items,
    undefined,
    requestOptions
  );
}

async function trigger_internal<TRunTypes extends AnyRunTypes>(
  name: string,
  id: TRunTypes["taskIdentifier"],
  payload: TRunTypes["payload"],
  parsePayload?: SchemaParseFn<TRunTypes["payload"]>,
  options?: TaskRunOptions,
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
        idempotencyKey: await makeKey(options?.idempotencyKey),
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
      attributes: {
        [SEMATTRS_MESSAGING_OPERATION]: "publish",
        ["messaging.client_id"]: taskContext.worker?.id,
        [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
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

  return handle as RunHandleFromTypes<TRunTypes>;
}

async function batchTrigger_internal<TRunTypes extends AnyRunTypes>(
  name: string,
  id: TRunTypes["taskIdentifier"],
  items: Array<BatchItem<TRunTypes["payload"]>>,
  parsePayload?: SchemaParseFn<TRunTypes["payload"]>,
  requestOptions?: TriggerApiRequestOptions,
  queue?: QueueOptions
): Promise<BatchRunHandleFromTypes<TRunTypes>> {
  const apiClient = apiClientManager.clientOrThrow();

  const response = await apiClient.batchTriggerTask(
    id,
    {
      items: await Promise.all(
        items.map(async (item) => {
          const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

          const payloadPacket = await stringifyIO(parsedPayload);

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
              parentAttempt: taskContext.ctx?.attempt.id,
              metadata: item.options?.metadata,
              maxDuration: item.options?.maxDuration,
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
      },
      ...requestOptions,
    }
  );

  const handle = {
    batchId: response.batchId,
    runs: response.runs.map((id) => ({ id })),
    publicAccessToken: response.publicAccessToken,
  };

  return handle as BatchRunHandleFromTypes<TRunTypes>;
}

async function triggerAndWait_internal<TPayload, TOutput>(
  name: string,
  id: string,
  payload: TPayload,
  parsePayload?: SchemaParseFn<TPayload>,
  options?: TaskRunOptions,
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
            idempotencyKey: await makeKey(options?.idempotencyKey),
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
      const response = await apiClient.batchTriggerTask(
        id,
        {
          items: await Promise.all(
            items.map(async (item) => {
              const parsedPayload = parsePayload ? await parsePayload(item.payload) : item.payload;

              const payloadPacket = await stringifyIO(parsedPayload);

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
