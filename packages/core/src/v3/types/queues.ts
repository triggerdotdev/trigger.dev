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
  /** An optional property that specifies the maximum number of concurrent run executions.
   *
   * If this property is omitted, the task can potentially use up the full concurrency of an environment */
  concurrencyLimit?: number;
  /** Rate limit configuration for controlling request frequency.
   *
   * Unlike concurrencyLimit (which controls how many tasks run at once),
   * rateLimit controls how frequently tasks can be dequeued.
   *
   * @example
   * ```ts
   * const rateLimitedQueue = queue({
   *   name: "api-calls",
   *   rateLimit: {
   *     limit: 10,
   *     period: "1s",
   *   },
   * });
   *
   * // Per-tenant rate limiting - pass rateLimitKey at trigger time
   * await myTask.trigger(payload, {
   *   rateLimitKey: `tenant-${payload.tenantId}`,
   * });
   *
   * // Also works with tasks.trigger()
   * await tasks.trigger("my-task", payload, {
   *   rateLimitKey: `tenant-${tenantId}`,
   * });
   * ```
   */
  rateLimit?: {
    /** Maximum number of requests allowed in the period */
    limit: number;
    /** Time window as a duration string (e.g., "1s", "100ms", "5m", "1h") */
    period: string;
    /** Optional burst allowance (defaults to limit) */
    burst?: number;
  };
};
