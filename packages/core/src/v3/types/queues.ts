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
  /** An optional property that caps the total number of concurrent run executions across ALL
   * `concurrencyKey` values of this queue.
   *
   * On a queue used with a `concurrencyKey`, `concurrencyLimit` applies to each key value
   * independently — ten active keys with `concurrencyLimit: 5` can run 50 at once. Setting
   * `totalConcurrencyLimit: 20` bounds the whole queue to 20 while each key still gets at
   * most `concurrencyLimit`.
   *
   * @example
   *
   * ```ts
   * const perUserQueue = queue({
      name: "per-user-queue",
      concurrencyLimit: 1,
      totalConcurrencyLimit: 10,
    });
   * ```
   *
   * Only enforced for runs triggered with a `concurrencyKey`, and requires server-side support.
   */
  totalConcurrencyLimit?: number;
};
