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
  /** An optional property that specifies whether to release concurrency on waitpoint.
   *
   * If this property is omitted, the task will not release concurrency on waitpoint.
   */
  releaseConcurrencyOnWaitpoint?: boolean;
};
