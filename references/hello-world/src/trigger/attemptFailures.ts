import { task } from "@trigger.dev/sdk";
import { setTimeout } from "timers/promises";

export const attemptFailures = task({
  id: "attempt-failures",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(5);

    await attemptFailureSubtask.triggerAndWait({}).unwrap();
  },
});

export const attemptFailureSubtask = task({
  id: "attempt-failure-subtask",
  retry: {
    maxAttempts: 1,
  },
  run: async (payload: any, { ctx }) => {
    await setTimeout(20_000);

    throw new Error("Forced error to cause a retry");
  },
});

export const attemptFailures2 = task({
  id: "attempt-failures-2",
  retry: {
    maxAttempts: 3,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 1000,
    factor: 1.5,
  },
  run: async (payload: any, { ctx }) => {
    if (ctx.attempt.number <= 2) {
      throw new Error("Forced error to cause a retry");
    }

    await setTimeout(10_000);

    return {
      success: true,
    };
  },
});
