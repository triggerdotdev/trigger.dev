import { SpanKind } from "@opentelemetry/api";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import {
  QueueOptions,
  RetryOptions,
  SemanticInternalAttributes,
  TaskRunContext,
  accessoryAttributes,
  apiClientManager,
  createErrorTaskError,
  defaultRetryOptions,
  flattenAttributes,
  runtime,
  taskContextManager,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";
import { tracer } from "./tracer";

export type PreparedItems = Record<string, any>;

export type RunFnParams<TPayload, TPreparedItems extends PreparedItems> = Prettify<{
  payload: TPayload;
  ctx: Context;
  prepared: TPreparedItems;
}>;

export type PrepareFnParams<TPayload> = Prettify<{
  payload: TPayload;
  ctx: Context;
}>;

export type Context = TaskRunContext;

export type SuccessFnParams<TPayload, TOutput, TPreparedItems extends PreparedItems> = RunFnParams<
  TPayload,
  TPreparedItems
> &
  Prettify<{
    output: TOutput;
  }>;

export type ErrorFnParams<TPayload, TPreparedItems extends PreparedItems> = RunFnParams<
  TPayload,
  TPreparedItems
> &
  Prettify<{
    error: unknown;
  }>;

type RequireOne<T, K extends keyof T> = {
  [X in Exclude<keyof T, K>]?: T[X];
} & {
  [P in K]-?: T[P];
};

export type Queue = RequireOne<QueueOptions, "name">;

export function queue(options: { name: string } & QueueOptions): Queue {
  return options;
}

export type RunOptions<TPayload, TOutput = any, TPreparedItems extends PreparedItems = any> = {
  id: string;
  retry?: RetryOptions;
  queue?: QueueOptions;
  machine?: {
    image?: "ffmpeg" | "puppeteer";
    cpu?: number;
    memory?: number;
  };
  run: (params: RunFnParams<TPayload, TPreparedItems>) => Promise<TOutput>;
  before?: (params: PrepareFnParams<TPayload>) => Promise<TPreparedItems>;
  onSuccess?: (params: SuccessFnParams<TPayload, TOutput, TPreparedItems>) => Promise<void>;
  onError?: (params: ErrorFnParams<TPayload, TPreparedItems>) => Promise<void>;
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

export function createTask<TInput, TOutput, TPreparedItems extends PreparedItems>(
  params: RunOptions<TInput, TOutput, TPreparedItems>
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
          const response = await apiClient.triggerTask(params.id, {
            payload: payload,
            options: {
              queue: params.queue,
              concurrencyKey: options?.concurrencyKey,
            },
          });

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
          const response = await apiClient.batchTriggerTask(params.id, {
            items: items.map((item) => ({
              payload: item.payload,
              options: {
                queue: item.options?.queue ?? params.queue,
                concurrencyKey: item.options?.concurrencyKey,
              },
            })),
          });

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
            [SemanticInternalAttributes.STYLE_ICON]: "batch-trigger",
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

          return JSON.parse(result.output);
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
                output: JSON.parse(item.output),
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
            [SemanticInternalAttributes.STYLE_ICON]: "batch-trigger",
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
      run: params.run,
      packageVersion: packageJson.version,
      queue: params.queue,
      retry: params.retry ? { ...defaultRetryOptions, ...params.retry } : undefined,
    },
    enumerable: false,
  });

  return task;
}
