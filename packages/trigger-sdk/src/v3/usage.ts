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
  totalCostInCents: number;
};

export const usage = {
  /**
   * Get the current running usage of this task run.
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
   *   // You have access to the current compute cost and duration up to this point
   *   console.log("Current attempt compute cost and duration", {
   *     cost: currentUsage.compute.attempt.costInCents,
   *     duration: currentUsage.compute.attempt.durationMs,
   *   });
   *
   *   // You also can see the total compute cost and duration up to this point in the run, across all attempts
   *   console.log("Current total compute cost and duration", {
   *     cost: currentUsage.compute.total.costInCents,
   *     duration: currentUsage.compute.total.durationMs,
   *   });
   *
   *   // You can see the base cost of the run, which is the cost of the run before any compute costs
   *   console.log("Total cost", {
   *     cost: currentUsage.totalCostInCents,
   *     baseCost: currentUsage.baseCostInCents,
   *   });
   *  },
   * });
   * ```
   */
  getCurrent: (): CurrentUsage => {
    const sample = usageApi.sample();
    const initialState = usageApi.getInitialState();
    const machine = taskContext.ctx?.machine;
    const run = taskContext.ctx?.run;

    if (!sample) {
      return {
        compute: {
          attempt: {
            costInCents: 0,
            durationMs: 0,
          },
          total: {
            costInCents: initialState.costInCents,
            durationMs: initialState.cpuTime,
          },
        },
        baseCostInCents: run?.baseCostInCents ?? 0,
        totalCostInCents: initialState.costInCents + (run?.baseCostInCents ?? 0),
      };
    }

    const currentCostInCents = machine?.centsPerMs ? sample.cpuTime * machine.centsPerMs : 0;

    return {
      compute: {
        attempt: {
          costInCents: currentCostInCents,
          durationMs: sample.cpuTime,
        },
        total: {
          costInCents: currentCostInCents + initialState.costInCents,
          durationMs: sample.cpuTime + initialState.cpuTime,
        },
      },
      baseCostInCents: run?.baseCostInCents ?? 0,
      totalCostInCents: currentCostInCents + (run?.baseCostInCents ?? 0) + initialState.costInCents,
    };
  },
  /**
   * Measure the cost and duration of a function.
   *
   * @example
   *
   * ```typescript
   * import { usage } from "@trigger.dev/sdk/v3";
   *
   * export const myTask = task({
   *  id: "my-task",
   *  run: async (payload, { ctx }) => {
   *    const { result, compute } = await usage.measure(async () => {
   *      // Do some work
   *      return "result";
   *    });
   *
   *    console.log("Result", result);
   *    console.log("Cost and duration", { cost: compute.costInCents, duration: compute.durationMs });
   *  },
   * });
   * ```
   */
  measure: async <T>(cb: () => Promise<T>): Promise<{ result: T; compute: ComputeUsage }> => {
    const measurement = usageApi.start();

    const result = await cb();

    const sample = usageApi.stop(measurement);
    const machine = taskContext.ctx?.machine;

    const costInCents = machine?.centsPerMs ? sample.cpuTime * machine.centsPerMs : 0;

    return {
      result,
      compute: {
        costInCents,
        durationMs: sample.cpuTime,
      },
    };
  },
};
