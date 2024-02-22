import { SpanKind } from "@opentelemetry/api";
import { SemanticAttributes } from "@opentelemetry/semantic-conventions";
import {
  ApiClient,
  QueueOptions,
  RetryOptions,
  TaskRunContext,
  createErrorTaskError,
  runtime,
  taskContextManager,
  defaultRetryOptions,
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
  itemCount: number;
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
  }) => Promise<TOutput[]>;
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
      const ctx = taskContextManager.ctx;

      const apiClient = initializeApiClient();

      const handle = await tracer.startActiveSpan(
        `${params.id} trigger`,
        async (span) => {
          const response = await apiClient.triggerTask(params.id, {
            payload: payload,
            options: {
              parentAttempt: ctx?.attempt.id,
              lockToCurrentVersion: false, // Don't lock to current version because we're not waiting for it to finish
              queue: params.queue,
              concurrencyKey: options?.concurrencyKey,
            },
          });

          if (!response.ok) {
            throw new Error(response.error);
          }

          span.setAttribute("trigger.id", response.data.id);

          return response.data;
        },
        {
          kind: SpanKind.PRODUCER,
          attributes: { [SemanticAttributes.MESSAGING_OPERATION]: "publish" },
        }
      );

      return handle;
    },
    batchTrigger: async ({ items }) => {
      const batchId = "batch_1234";
      //todo actually call the API to start the task group
      return {
        batchId,
        itemCount: items.length,
      };
    },
    triggerAndWait: async ({ payload, options }) => {
      const ctx = taskContextManager.ctx;

      if (!ctx) {
        throw new Error("triggerAndWait can only be used from inside a task.run()");
      }

      const apiClient = initializeApiClient();

      return await tracer.startActiveSpan(
        `${params.id} trigger`,
        async (span) => {
          span.setAttribute(SemanticAttributes.MESSAGING_OPERATION, "publish");

          const response = await apiClient.triggerTask(params.id, {
            payload: payload,
            options: {
              parentAttempt: ctx.attempt.id,
              lockToCurrentVersion: true, // Lock to current version because we're waiting for it to finish
              queue: params.queue,
              concurrencyKey: options?.concurrencyKey,
            },
          });

          if (!response.ok) {
            throw new Error(response.error);
          }

          const result = await runtime.waitForTask({
            id: response.data.id,
            ctx,
          });

          if (!result.ok) {
            throw createErrorTaskError(result.error);
          }

          return JSON.parse(result.output);
        },
        { kind: SpanKind.PRODUCER }
      );
    },
    batchTriggerAndWait: async ({ items }) => {
      //pseudo-code for throwing an error if not called from inside a Run
      if (!process.env.IS_TRIGGER_ENV) {
        throw new Error("batchTriggerAndWait can only be used from inside a run()");
      }

      //todo do an API call that creates a TaskGroup
      //then waits for it to finish
      //then return the result
      throw new Error("not implemented");
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

// TODO: make this cross-runtime compatible
function initializeApiClient() {
  return new ApiClient(process.env.TRIGGER_API_URL!, process.env.TRIGGER_API_KEY!);
}
