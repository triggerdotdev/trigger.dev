import { SpanKind } from "@opentelemetry/api";
import {
  SEMATTRS_MESSAGING_DESTINATION,
  SEMATTRS_MESSAGING_OPERATION,
  SEMATTRS_MESSAGING_SYSTEM,
} from "@opentelemetry/semantic-conventions";
import {
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
  SemanticInternalAttributes,
  SuccessFnParams,
  TaskRunContext,
  TaskRunExecutionResult,
  accessoryAttributes,
  apiClientManager,
  conditionallyImportPacket,
  createErrorTaskError,
  defaultRetryOptions,
  parsePacket,
  runtime,
  stringifyIO,
  taskCatalog,
  taskContextManager,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";
import { tracer } from "./tracer";

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

export type TaskOptions<TPayload, TOutput = any, TInitOutput extends InitOutput = any> = {
  /** An id for your task. This must be unique inside your project and not change between versions.  */
  id: string;
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
     */
    memory?: MachineMemory;
  };
  /** This gets called when a task is triggered. It's where you put the code you want to execute.
   *
   * @param payload - The payload that is passed to your task when it's triggered. This must be JSON serializable.
   * @param params - Metadata about the run.
   */
  run: (payload: TPayload, params: RunFnParams<TInitOutput>) => Promise<TOutput>;
  init?: (payload: TPayload, params: InitFnParams) => Promise<TInitOutput>;
  handleError?: (
    payload: TPayload,
    error: unknown,
    params: HandleErrorFnParams<TInitOutput>
  ) => HandleErrorResult;
  cleanup?: (payload: TPayload, params: RunFnParams<TInitOutput>) => Promise<void>;
  middleware?: (payload: TPayload, params: MiddlewareFnParams) => Promise<void>;
  onSuccess?: (payload: TPayload, params: SuccessFnParams<TOutput, TInitOutput>) => Promise<void>;
};

type InvokeHandle = {
  id: string;
};

type InvokeBatchHandle = {
  batchId: string;
  runs: string[];
};

export type TaskRunResult<TOutput = any> =
  | {
      ok: true;
      id: string;
      output: TOutput;
    }
  | {
      ok: false;
      id: string;
      error: any;
    };

export type BatchResult<TOutput = any> = {
  id: string;
  runs: TaskRunResult<TOutput>[];
};

export interface Task<TInput, TOutput = any> {
  id: string;
  trigger: (params: { payload: TInput; options?: TaskRunOptions }) => Promise<InvokeHandle>;
  batchTrigger: (params: {
    items: { payload: TInput; options?: TaskRunOptions }[];
    batchOptions?: BatchRunOptions;
  }) => Promise<InvokeBatchHandle>;
  triggerAndWait: (params: { payload: TInput; options?: TaskRunOptions }) => Promise<TOutput>;
  batchTriggerAndWait: (params: {
    items: { payload: TInput; options?: TaskRunOptions }[];
    batchOptions?: BatchRunOptions;
  }) => Promise<BatchResult<TOutput>>;
}

type TaskRunOptions = {
  idempotencyKey?: string;
  maxAttempts?: number;
  startAt?: Date;
  startAfter?: number;
  queue?: TaskRunConcurrencyOptions;
  concurrencyKey?: string;
};

type TaskRunConcurrencyOptions = Queue;

type BatchRunOptions = TaskRunOptions & {
  maxConcurrency?: number;
};

export type Prettify<T> = {
  [K in keyof T]: T[K];
} & {};

export type DynamicBaseOptions = {
  id: string;
};

export function createTask<TInput, TOutput, TInitOutput extends InitOutput>(
  params: TaskOptions<TInput, TOutput, TInitOutput>
): Task<TInput, TOutput> {
  const task: Task<TInput, TOutput> = {
    id: params.id,
    trigger: async ({ payload, options }) => {
      const apiClient = apiClientManager.client;

      if (!apiClient) {
        throw apiClientMissingError();
      }

      const taskMetadata = taskCatalog.getTaskMetadata(params.id);

      const payloadPacket = await stringifyIO(payload);

      const handle = await tracer.startActiveSpan(
        taskMetadata ? "Trigger" : `${params.id} trigger()`,
        async (span) => {
          const response = await apiClient.triggerTask(
            params.id,
            {
              payload: payloadPacket.data,
              options: {
                queue: params.queue,
                concurrencyKey: options?.concurrencyKey,
                test: taskContextManager.ctx?.run.isTest,
                payloadType: payloadPacket.dataType,
                idempotencyKey: options?.idempotencyKey,
              },
            },
            { spanParentAsLink: true }
          );

          if (!response.ok) {
            throw new Error(response.error);
          }

          span.setAttribute("messaging.message.id", response.data.id);

          return response.data;
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SEMATTRS_MESSAGING_OPERATION]: "publish",
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SEMATTRS_MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: JSON.stringify(payload).length,
            [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
            ...(taskMetadata
              ? accessoryAttributes({
                  items: [
                    {
                      text: `${taskMetadata.exportName}.trigger()`,
                      variant: "normal",
                    },
                  ],
                  style: "codepath",
                })
              : {}),
          },
        }
      );

      return handle;
    },
    batchTrigger: async ({ items }) => {
      const apiClient = apiClientManager.client;

      if (!apiClient) {
        throw apiClientMissingError();
      }

      const taskMetadata = taskCatalog.getTaskMetadata(params.id);

      const response = await tracer.startActiveSpan(
        taskMetadata ? "Batch trigger" : `${params.id} batchTrigger()`,
        async (span) => {
          const response = await apiClient.batchTriggerTask(
            params.id,
            {
              items: await Promise.all(
                items.map(async (item) => {
                  const payloadPacket = await stringifyIO(item.payload);

                  return {
                    payload: payloadPacket.data,
                    options: {
                      queue: item.options?.queue ?? params.queue,
                      concurrencyKey: item.options?.concurrencyKey,
                      test: taskContextManager.ctx?.run.isTest,
                      payloadType: payloadPacket.dataType,
                      idempotencyKey: item.options?.idempotencyKey,
                    },
                  };
                })
              ),
            },
            { spanParentAsLink: true }
          );

          if (!response.ok) {
            throw new Error(response.error);
          }

          span.setAttribute("messaging.message.id", response.data.batchId);

          return response.data;
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SEMATTRS_MESSAGING_OPERATION]: "publish",
            ["messaging.batch.message_count"]: items.length,
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SEMATTRS_MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: items
              .map((item) => JSON.stringify(item.payload))
              .join("").length,
            [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            ...(taskMetadata
              ? accessoryAttributes({
                  items: [
                    {
                      text: `${taskMetadata.exportName}.batchTrigger()`,
                      variant: "normal",
                    },
                  ],
                  style: "codepath",
                })
              : {}),
          },
        }
      );

      return response;
    },
    triggerAndWait: async ({ payload, options }) => {
      const ctx = taskContextManager.ctx;

      if (!ctx) {
        throw new Error("triggerAndWait can only be used from inside a task.run()");
      }

      const apiClient = apiClientManager.client;

      if (!apiClient) {
        throw apiClientMissingError();
      }

      const taskMetadata = taskCatalog.getTaskMetadata(params.id);

      const payloadPacket = await stringifyIO(payload);

      return await tracer.startActiveSpan(
        taskMetadata ? "Trigger" : `${params.id} triggerAndWait()`,
        async (span) => {
          const response = await apiClient.triggerTask(params.id, {
            payload: payloadPacket.data,
            options: {
              dependentAttempt: ctx.attempt.id,
              lockToVersion: taskContextManager.worker?.version, // Lock to current version because we're waiting for it to finish
              queue: params.queue,
              concurrencyKey: options?.concurrencyKey,
              test: taskContextManager.ctx?.run.isTest,
              payloadType: payloadPacket.dataType,
              idempotencyKey: options?.idempotencyKey,
            },
          });

          if (!response.ok) {
            throw new Error(response.error);
          }

          span.setAttribute("messaging.message.id", response.data.id);

          const result = await runtime.waitForTask({
            id: response.data.id,
            ctx,
          });

          const runResult = await handleTaskRunExecutionResult<TOutput>(result);

          if (!runResult.ok) {
            throw runResult.error;
          }

          return runResult.output;
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            [SEMATTRS_MESSAGING_OPERATION]: "publish",
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SEMATTRS_MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
            ...(taskMetadata
              ? accessoryAttributes({
                  items: [
                    {
                      text: `${taskMetadata.exportName}.triggerAndWait()`,
                      variant: "normal",
                    },
                  ],
                  style: "codepath",
                })
              : {}),
          },
        }
      );
    },
    batchTriggerAndWait: async ({ items }) => {
      const ctx = taskContextManager.ctx;

      if (!ctx) {
        throw new Error("batchTriggerAndWait can only be used from inside a task.run()");
      }

      const apiClient = apiClientManager.client;

      if (!apiClient) {
        throw apiClientMissingError();
      }

      const taskMetadata = taskCatalog.getTaskMetadata(params.id);

      return await tracer.startActiveSpan(
        taskMetadata ? "Batch trigger" : `${params.id} batchTriggerAndWait()`,
        async (span) => {
          const response = await apiClient.batchTriggerTask(params.id, {
            items: await Promise.all(
              items.map(async (item) => {
                const payloadPacket = await stringifyIO(item.payload);

                return {
                  payload: payloadPacket.data,
                  options: {
                    lockToVersion: taskContextManager.worker?.version,
                    queue: item.options?.queue ?? params.queue,
                    concurrencyKey: item.options?.concurrencyKey,
                    test: taskContextManager.ctx?.run.isTest,
                    payloadType: payloadPacket.dataType,
                    idempotencyKey: item.options?.idempotencyKey,
                  },
                };
              })
            ),
            dependentAttempt: ctx.attempt.id,
          });

          if (!response.ok) {
            throw new Error(response.error);
          }

          span.setAttribute("messaging.message.id", response.data.batchId);

          const result = await runtime.waitForBatch({
            id: response.data.batchId,
            runs: response.data.runs,
            ctx,
          });

          const runs = await handleBatchTaskRunExecutionResult<TOutput>(result.items);

          return {
            id: result.id,
            runs,
          };
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SEMATTRS_MESSAGING_OPERATION]: "publish",
            ["messaging.batch.message_count"]: items.length,
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SEMATTRS_MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: items
              .map((item) => JSON.stringify(item.payload))
              .join("").length,
            [SEMATTRS_MESSAGING_SYSTEM]: "trigger.dev",
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            ...(taskMetadata
              ? accessoryAttributes({
                  items: [
                    {
                      text: `${taskMetadata.exportName}.batchTriggerAndWait()`,
                      variant: "normal",
                    },
                  ],
                  style: "codepath",
                })
              : {}),
          },
        }
      );
    },
  };

  taskCatalog.registerTaskMetadata({
    id: params.id,
    packageVersion: packageJson.version,
    queue: params.queue,
    retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    machine: params.machine,
    fns: {
      run: params.run,
      init: params.init,
      cleanup: params.cleanup,
      middleware: params.middleware,
      handleError: params.handleError,
    },
  });

  return task;
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
