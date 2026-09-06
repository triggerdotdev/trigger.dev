export type QueueOptions = {
  /** You can define a shared queue and then pass the name in to your task.
   *
   * @example
   *
   * ```ts
   * const myQueue = queue({
      name: "my-queue",
      concurrencyLimit: 1,
    });

    export const task1 = task({
      id: "task-1",
      queue: {
        name: "my-queue",
      },
      run: async (payload: { message: string }) => {
        // ...
      },
    });

    export const task2 = task({
      id: "task-2",
      queue: {
        name: "my-queue",
      },
      run: async (payload: { message: string }) => {
        // ...
      },
    });
   * ```
   */
  name: string;
  /**
   * @deprecated Use `concurrency` on the task instead. `concurrencyLimit: 10` applies per
   * `concurrencyKey` when runs pass one, and to the whole queue when they don't. The task's
   * `concurrency` option says which you mean: `{ total: 10 }` caps the task outright;
   * `{ perKey: 10 }` caps each key. Existing queues keep working unchanged.
   */
  concurrencyLimit?: number;
};

/**
 * One limit shape everywhere a limit appears. `perKey` caps each `concurrencyKey` pool
 * (runs without a key share one pool); `total` caps across everything, keys or not.
 * Either alone or both together.
 */
export type ConcurrencyShape = {
  perKey?: number;
  total?: number;
};

/** Options for `concurrencyLimit()`: a named, shareable concurrency limit.
 *
 * @example
 *
 * ```ts
 * export const openaiLimit = concurrencyLimit({ name: "openai", total: 25 });
 *
 * export const generateSummary = task({
 *   id: "generate-summary",
 *   concurrency: [{ total: 5 }, openaiLimit],
 *   run: async (payload) => {},
 * });
 * ```
 */
export type ConcurrencyLimitOptions = { name: string } & ConcurrencyShape;

export type ConcurrencyLimit = ConcurrencyLimitOptions;

/**
 * A task's concurrency: one limit or an array of limits. An inline shape caps this task;
 * a named limit (a `concurrencyLimit()` instance or its name) is shared across every task
 * holding it. At most one inline limit plus up to two named limits.
 */
export type TaskConcurrency =
  | ConcurrencyShape
  | ConcurrencyLimit
  | string
  | Array<ConcurrencyShape | ConcurrencyLimit | string>;
