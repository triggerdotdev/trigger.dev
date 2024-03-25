import { SpanKind } from "@opentelemetry/api";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import {
  HandleErrorFnParams,
  HandleErrorResult,
  InitFnParams,
  InitOutput,
  MiddlewareFnParams,
  QueueOptions,
  RetryOptions,
  RunFnParams,
  SemanticInternalAttributes,
  SuccessFnParams,
  TaskRunContext,
  accessoryAttributes,
  apiClientManager,
  createErrorTaskError,
  defaultRetryOptions,
  flattenAttributes,
  parseOutput,
  runtime,
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
    cpu?: 0.25 | 0.5 | 1 | 2 | 4;
    /** In GBs of RAM. The default is 0.5.
     *
     * Possible values:
     * - 0.25
     * - 0.5
     * - 1
     * - 2
     * - 4
     * - 8
     */
    memory?: 0.25 | 0.5 | 1 | 2 | 4 | 8;
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

export type Task<TInput, TOutput = any> = {
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
};

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
    trigger: async ({ payload, options }) => {
      const apiClient = apiClientManager.client;

      if (!apiClient) {
        throw new Error("API client is not initialized");
      }

      const taskMetadata = runtime.getTaskMetadata(params.id);

      const handle = await tracer.startActiveSpan(
        taskMetadata ? "Trigger" : `${params.id} trigger()`,
        async (span) => {
          const response = await apiClient.triggerTask(
            params.id,
            {
              payload: payload,
              options: {
                queue: params.queue,
                concurrencyKey: options?.concurrencyKey,
                test: taskContextManager.ctx?.run.isTest,
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
            [SemanticAttributes.MESSAGING_OPERATION]: "publish",
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SemanticAttributes.MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: JSON.stringify(payload).length,
            [SemanticAttributes.MESSAGING_SYSTEM]: "trigger.dev",
            ...flattenAttributes(payload as any, SemanticInternalAttributes.PAYLOAD),
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
        throw new Error("API client is not initialized");
      }

      const taskMetadata = runtime.getTaskMetadata(params.id);

      const response = await tracer.startActiveSpan(
        taskMetadata ? "Batch trigger" : `${params.id} batchTrigger()`,
        async (span) => {
          const response = await apiClient.batchTriggerTask(
            params.id,
            {
              items: items.map((item) => ({
                payload: item.payload,
                options: {
                  queue: item.options?.queue ?? params.queue,
                  concurrencyKey: item.options?.concurrencyKey,
                  test: taskContextManager.ctx?.run.isTest,
                },
              })),
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
            [SemanticAttributes.MESSAGING_OPERATION]: "publish",
            ["messaging.batch.message_count"]: items.length,
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SemanticAttributes.MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: items
              .map((item) => JSON.stringify(item.payload))
              .join("").length,
            [SemanticAttributes.MESSAGING_SYSTEM]: "trigger.dev",
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
        throw new Error("API client is not initialized");
      }

      const taskMetadata = runtime.getTaskMetadata(params.id);

      return await tracer.startActiveSpan(
        taskMetadata ? "Trigger" : `${params.id} triggerAndWait()`,
        async (span) => {
          const response = await apiClient.triggerTask(params.id, {
            payload: payload,
            options: {
              dependentAttempt: ctx.attempt.id,
              lockToVersion: taskContextManager.worker?.version, // Lock to current version because we're waiting for it to finish
              queue: params.queue,
              concurrencyKey: options?.concurrencyKey,
              test: taskContextManager.ctx?.run.isTest,
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

          if (!result.ok) {
            throw createErrorTaskError(result.error);
          }

          return parseOutput(result);
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SemanticInternalAttributes.STYLE_ICON]: "trigger",
            [SemanticAttributes.MESSAGING_OPERATION]: "publish",
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SemanticAttributes.MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: JSON.stringify(payload).length,
            [SemanticAttributes.MESSAGING_SYSTEM]: "trigger.dev",
            ...flattenAttributes(payload as any, SemanticInternalAttributes.PAYLOAD),
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
        throw new Error("API client is not initialized");
      }

      const taskMetadata = runtime.getTaskMetadata(params.id);

      return await tracer.startActiveSpan(
        taskMetadata ? "Batch trigger" : `${params.id} batchTriggerAndWait()`,
        async (span) => {
          const response = await apiClient.batchTriggerTask(params.id, {
            items: items.map((item) => ({
              payload: item.payload,
              options: {
                lockToVersion: taskContextManager.worker?.version,
                queue: item.options?.queue ?? params.queue,
                concurrencyKey: item.options?.concurrencyKey,
                test: taskContextManager.ctx?.run.isTest,
              },
            })),
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

          const runs = result.items.map((item) => {
            if (item.ok) {
              return {
                ok: true,
                id: item.id,
                output: parseOutput(item),
              } satisfies TaskRunResult<TOutput>;
            } else {
              return {
                ok: false,
                id: item.id,
                error: createErrorTaskError(item.error),
              } satisfies TaskRunResult<TOutput>;
            }
          });

          return {
            id: result.id,
            runs,
          };
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: {
            [SemanticAttributes.MESSAGING_OPERATION]: "publish",
            ["messaging.batch.message_count"]: items.length,
            ["messaging.client_id"]: taskContextManager.worker?.id,
            [SemanticAttributes.MESSAGING_DESTINATION]: params.queue?.name ?? params.id,
            ["messaging.message.body.size"]: items
              .map((item) => JSON.stringify(item.payload))
              .join("").length,
            [SemanticAttributes.MESSAGING_SYSTEM]: "trigger.dev",
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

  Object.defineProperty(task, "__trigger", {
    value: {
      id: params.id,
      packageVersion: packageJson.version,
      queue: params.queue,
      retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
      fns: {
        run: params.run,
        init: params.init,
        cleanup: params.cleanup,
        middleware: params.middleware,
        handleError: params.handleError,
      },
    },
    enumerable: false,
  });

  return task;
}
