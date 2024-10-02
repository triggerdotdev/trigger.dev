import { logger, task, usage, wait } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const maxDurationTask = task({
  id: "max-duration",
  maxDuration: 15, // 15 seconds
  run: async (payload: { sleepFor: number }, { signal }) => {
    await setTimeout(payload.sleepFor * 1000, { signal });

    return usage.getCurrent();
  },
});

export const maxDurationParentTask = task({
  id: "max-duration-parent",
  run: async (payload: any, { ctx, signal }) => {
    const result = await maxDurationTask.triggerAndWait({ sleepFor: 10 }, { maxDuration: 600 });

    return result;
  },
});
