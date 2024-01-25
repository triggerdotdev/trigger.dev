import {
  ApiClient,
  TaskRunContext,
  createErrorTaskError,
  runtime,
  taskContextManager,
} from "@trigger.dev/core/v3";
import * as packageJson from "../../package.json";

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

type RateLimitOptions =
  | {
      hourly: number;
    }
  | {
      daily: number;
    }
  | {
      monthly: number;
    };

type QueueOptions = {
  concurrencyLimit?: number;
  rateLimit?: RateLimitOptions;
};

export type Queue = {
  name: string;
} & QueueOptions;

export function queue(options: { name: string } & QueueOptions): Queue {
  return options;
}

export type RunOptions<TPayload, TOutput = any, TPreparedItems extends PreparedItems = any> = {
  id: string;
  retry?: {
    maxAttempts?: number;
  };
  queue?: QueueOptions | Queue;
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
    trigger: async ({ payload }) => {
      const apiClient = initializeApiClient();

      const response = await apiClient.triggerTask(params.id, {
        payload: payload,
      });

      if (!response.ok) {
        throw new Error(response.error);
      }

      return response.data;
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

      const response = await apiClient.triggerTask(params.id, {
        payload: payload,
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
    },
    enumerable: false,
  });

  return task;
}

// TODO: make this cross-runtime compatible
function initializeApiClient() {
  return new ApiClient(process.env.TRIGGER_API_URL!, process.env.TRIGGER_API_KEY!);
}
