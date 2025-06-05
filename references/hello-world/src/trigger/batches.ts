import { task } from "@trigger.dev/sdk/v3";
import { setTimeout } from "timers/promises";

export const batchTriggerAndWait = task({
  id: "batch-trigger-and-wait",
  maxDuration: 60,
  run: async (payload: { count: number }, { ctx }) => {
    const payloads = Array.from({ length: payload.count }, (_, i) => ({
      payload: { waitSeconds: 1, output: `test${i}` },
    }));

    // First batch triggerAndWait with idempotency keys
    const firstResults = await fixedLengthTask.batchTriggerAndWait(payloads);
  },
});

type Payload = {
  waitSeconds: number;
  error?: string;
  output?: any;
};

export const fixedLengthTask = task({
  id: "fixed-length-lask",
  retry: {
    maxAttempts: 2,
    maxTimeoutInMs: 100,
  },
  machine: "micro",
  run: async ({ waitSeconds = 1, error, output }: Payload) => {
    await setTimeout(waitSeconds * 1000);

    if (error) {
      throw new Error(error);
    }

    return output;
  },
});
