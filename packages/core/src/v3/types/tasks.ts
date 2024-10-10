import { SerializableJson } from "../../schemas/json.js";
import { RunTags } from "../schemas/api.js";
import { QueueOptions } from "../schemas/schemas.js";
import { IdempotencyKey } from "./idempotencyKeys.js";

type RequireOne<T, K extends keyof T> = {
  [X in Exclude<keyof T, K>]?: T[X];
} & {
  [P in K]-?: T[P];
};

export type Queue = RequireOne<QueueOptions, "name">;

type TaskRunConcurrencyOptions = Queue;

export class SubtaskUnwrapError extends Error {
  public readonly taskId: string;
  public readonly runId: string;
  public readonly cause?: unknown;

  constructor(taskId: string, runId: string, subtaskError: unknown) {
    if (subtaskError instanceof Error) {
      super(`Error in ${taskId}: ${subtaskError.message}`, { cause: subtaskError });
      this.name = "SubtaskUnwrapError";
    } else {
      super(`Error in ${taskId}`, { cause: subtaskError });
      this.name = "SubtaskUnwrapError";
    }

    this.taskId = taskId;
    this.runId = runId;
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
        throw new SubtaskUnwrapError(this.taskId, result.id, result.error);
      }
    });
  }
}

declare const __output: unique symbol;
declare const __payload: unique symbol;
type BrandRun<P, O> = { [__output]: O; [__payload]: P };
export type BrandedRun<T, P, O> = T & BrandRun<O, P>;

export type RunHandle<TPayload, TOutput> = BrandedRun<
  {
    id: string;
  },
  TPayload,
  TOutput
>;

export type AnyRunHandle = RunHandle<any, any>;

/**
 * A BatchRunHandle can be used to retrieve the runs of a batch trigger in a typesafe manner.
 */
export type BatchRunHandle<TPayload, TOutput> = BrandedRun<
  {
    batchId: string;
    runs: Array<RunHandle<TPayload, TOutput>>;
  },
  TOutput,
  TPayload
>;

export type RunHandleOutput<TRunHandle> = TRunHandle extends RunHandle<any, infer TOutput>
  ? TOutput
  : never;

export type RunHandlePayload<TRunHandle> = TRunHandle extends RunHandle<infer TPayload, any>
  ? TPayload
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
  trigger: (payload: TInput, options?: TaskRunOptions) => Promise<RunHandle<TInput, TOutput>>;

  /**
   * Batch trigger multiple task runs with the given payloads, and continue without waiting for the results. If you want to wait for the results, use `batchTriggerAndWait`. Returns the id of the triggered batch.
   * @param items
   * @returns InvokeBatchHandle
   * - `batchId` - The id of the triggered batch.
   * - `runs` - The ids of the triggered task runs.
   */
  batchTrigger: (items: Array<BatchItem<TInput>>) => Promise<BatchRunHandle<TInput, TOutput>>;

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

export type TaskOutputHandle<TTask extends AnyTask> = TTask extends Task<
  string,
  infer TInput,
  infer TOutput
>
  ? RunHandle<TOutput, TInput>
  : never;

export type TaskBatchOutputHandle<TTask extends AnyTask> = TTask extends Task<
  string,
  infer TInput,
  infer TOutput
>
  ? BatchRunHandle<TOutput, TInput>
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

  /**
   * Metadata to attach to the run. Metadata can be used to store additional information about the run. Limited to 4KB.
   */
  metadata?: Record<string, SerializableJson>;

  /**
   * The maximum duration in compute-time seconds that a task run is allowed to run. If the task run exceeds this duration, it will be stopped.
   *
   * This will override the task's maxDuration.
   *
   * Minimum value is 5 seconds
   */
  maxDuration?: number;
};
