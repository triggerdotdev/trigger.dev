import { usage as usageApi, taskContext } from "@trigger.dev/core/v3";

export type ComputeUsage = {
  costInCents: number;
  durationMs: number;
};

// What about run start cost and what should we call that? Some better names
export type CurrentUsage = {
  compute: {
    attempt: ComputeUsage;
    total: ComputeUsage;
  };
  baseCostInCents: number;
  totalInCents: number;
};

export const usage = {
  /**
   * Get the current usage of this task run attempt.
   *
   * @returns The current usage of this task run attempt.
   *
   * @example
   *
   * ```typescript
   * import { usage, task } from "@trigger.dev/sdk/v3";
   *
   * export const myTask = task({
   *  id: "my-task",
   *  run: async (payload, { ctx }) => {
   *   // ... Do a bunch of work
   *
   *   const currentUsage = usage.getCurrent();
   *
   *   console.log("Current cost and duration", {
   *     cost: currentUsage.costInCents,
   *     duration: currentUsage.durationMs,
   *   });
   *
   *   // Use ctx to access the total run cost and duration
   *   console.log("Total cost and duration", {
   *     cost: ctx.run.costInCents + currentUsage.costInCents,
   *     duration: ctx.run.durationMs + currentUsage.durationMs,
   *   });
   *  },
   * });
   * ```
   */
  getCurrent: (): CurrentUsage => {
    const sample = usageApi.sample();

    if (!sample) {
      return {
        costInCents: 0,
        durationMs: 0,
      };
    }

    const machine = taskContext.ctx?.machine;

    return {
      costInCents: machine?.centsPerMs ? sample.cpuTime * machine.centsPerMs : 0,
      durationMs: sample.cpuTime,
    };
  },
};
